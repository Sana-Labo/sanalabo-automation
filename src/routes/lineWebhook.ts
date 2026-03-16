import { Hono } from "hono";
import { runAgentLoop } from "../agent/loop.js";
import { notifyActionResult } from "../approvals/notify.js";
import { clearUrgentCheckpoint } from "../jobs/index.js";
import {
  verifyLineSignature,
  parseLineEvents,
  extractTextMessage,
  extractPostbackData,
  extractUserId,
  isFollowEvent,
  isUnfollowEvent,
  isPostbackEvent,
  isTextMessageEvent,
} from "../channels/line.js";
import { config } from "../config.js";
import { getGwsExecutors } from "../skills/gws/executor.js";
import { toErrorMessage } from "../utils/error.js";
import type {
  AgentDependencies,
  LineFollowEvent,
  LinePostbackEvent,
  LineMessageEvent,
  LineWebhookEvent,
  ToolContext,
} from "../types.js";
import type { UserStore } from "../users/store.js";

const INVITE_PATTERN = /^invite\s+(U[0-9a-f]{32})$/i;
const APPROVAL_PATTERN = /^(approve|reject)\s+(\S+)(?:\s+(.*))?$/i;

export function createLineWebhookRoute(
  deps: AgentDependencies,
  userStore: UserStore,
) {
  const route = new Hono();

  // --- Shared helpers ---

  async function sendText(userId: string, text: string): Promise<void> {
    const exec = deps.registry.executors.get("push_text_message");
    if (exec) await exec({ user_id: userId, text });
  }

  // Per-user queues: sequential within same user (conversation order),
  // parallel across different users (no cross-user blocking)
  interface UserQueue {
    tasks: Array<() => Promise<void>>;
    processing: boolean;
  }
  const userQueues = new Map<string, UserQueue>();

  async function processUserQueue(userId: string): Promise<void> {
    const uq = userQueues.get(userId);
    if (!uq || uq.processing) return;
    uq.processing = true;
    while (uq.tasks.length > 0) {
      const task = uq.tasks.shift()!;
      try {
        await task();
      } catch (err) {
        console.error(`[webhook] Agent loop error for ${userId}:`, err);
      }
    }
    uq.processing = false;
    if (uq.tasks.length === 0) userQueues.delete(userId);
  }

  function enqueue(userId: string, fn: () => Promise<void>): void {
    let uq = userQueues.get(userId);
    if (!uq) {
      uq = { tasks: [], processing: false };
      userQueues.set(userId, uq);
    }
    uq.tasks.push(fn);
    void processUserQueue(userId);
  }

  function resolveContext(userId: string): ToolContext | undefined {
    const defaultWsId = userStore.getDefaultWorkspaceId(userId);
    const workspace = deps.workspaceStore.resolveWorkspace(userId, defaultWsId);
    if (!workspace) return undefined;

    const role = deps.workspaceStore.getUserRole(workspace.id, userId);
    if (!role) return undefined;

    return { userId, workspaceId: workspace.id, role };
  }

  async function sendWorkspaceSelectionPrompt(userId: string): Promise<void> {
    const workspaces = deps.workspaceStore.getByMember(userId);
    if (workspaces.length === 0) return;
    const list = workspaces.map((ws) => `・${ws.name} (${ws.id})`).join("\n");
    await sendText(
      userId,
      `複数のワークスペースに所属しています。デフォルトを設定してください:\n${list}\n\n「use <ID>」と送信してください。`,
    );
  }

  function enqueueAgent(prompt: string, userId: string): void {
    enqueue(userId, async () => {
      const context = resolveContext(userId);
      if (!context) {
        await sendWorkspaceSelectionPrompt(userId);
        return;
      }
      await runAgentLoop(prompt, deps, context);
    });
  }

  // --- Event Handlers ---

  function handleFollow(
    event: LineFollowEvent,
    userId: string,
  ): void {
    // System admin re-follow: reactivate without invitation check
    if (userStore.isSystemAdmin(userId) && !userStore.isActive(userId)) {
      enqueue(userId, async () => {
        await userStore.activate(userId);
        const context = resolveContext(userId);
        if (context) {
          await runAgentLoop(
            "管理者ユーザーが再参加しました。おかえりなさいとLINEで伝えてください。",
            deps,
            context,
          );
        } else {
          console.warn(`[webhook] System admin ${userId} re-followed but has no resolvable workspace`);
          await sendWorkspaceSelectionPrompt(userId);
        }
      });
    } else if (userStore.isInvited(userId)) {
      enqueue(userId, async () => {
        await userStore.activate(userId);
        const context = resolveContext(userId);
        if (context) {
          await runAgentLoop(
            "新しいユーザーが参加しました。簡単な挨拶と使い方をLINEで案内してください。",
            deps,
            context,
          );
        } else {
          await sendWorkspaceSelectionPrompt(userId);
        }
      });
    } else if (!userStore.isActive(userId)) {
      console.log(`[webhook] Uninvited follow from ${userId}, ignoring`);
    }
  }

  function handleUnfollow(userId: string): void {
    if (userStore.isActive(userId)) {
      enqueue(userId, async () => {
        await userStore.deactivate(userId);
        clearUrgentCheckpoint(userId);
      });
    }
  }

  function handleTextMessage(
    event: LineMessageEvent,
    userId: string,
  ): void {
    if (!userStore.isActive(userId)) return;

    const text = extractTextMessage(event);

    // System admin: workspace creation command
    const createWsMatch = /^create-workspace\s+(.+?)\s+(U[0-9a-f]{32})$/i.exec(text);
    if (userStore.isSystemAdmin(userId) && createWsMatch) {
      const [, wsName, ownerId] = createWsMatch;
      enqueue(userId, async () => {
        const ws = await deps.workspaceStore.create(wsName!, ownerId!);
        await sendText(
          userId,
          `ワークスペース「${ws.name}」(${ws.id})を作成しました。\nオーナー: ${ownerId}\nGWS認証: docker exec -it assistant gws auth login --config-dir ${ws.gwsConfigDir}`,
        );
      });
      return;
    }

    // Owner invite command — deterministic, not Claude-dependent
    const inviteMatch = INVITE_PATTERN.exec(text);
    if (inviteMatch) {
      const targetId = inviteMatch[1]!;
      enqueue(userId, async () => {
        const ownerWs = deps.workspaceStore.getByOwner(userId);
        const context = resolveContext(userId);

        if (ownerWs.length === 0) {
          if (userStore.isSystemAdmin(userId)) {
            await userStore.invite(targetId, userId);
            if (context) {
              await runAgentLoop(
                `ユーザー ${targetId} を招待しました。招待完了をLINEで報告してください。`,
                deps,
                context,
              );
            }
          }
          return;
        }

        const ws = ownerWs.length === 1 ? ownerWs[0]! : ownerWs.find((w) => w.id === userStore.getDefaultWorkspaceId(userId)) ?? ownerWs[0]!;
        await userStore.invite(targetId, userId);
        await deps.workspaceStore.inviteMember(ws.id, targetId, userId);

        if (!userStore.getDefaultWorkspaceId(targetId)) {
          await userStore.setDefaultWorkspaceId(targetId, ws.id);
        }

        if (context) {
          await runAgentLoop(
            `ユーザー ${targetId} をワークスペース「${ws.name}」に招待しました。招待完了をLINEで報告してください。`,
            deps,
            context,
          );
        }
      });
      return;
    }

    // Approval commands (approve/reject)
    const approvalMatch = APPROVAL_PATTERN.exec(text);
    if (approvalMatch) {
      const [, action, actionId, reason] = approvalMatch;
      enqueue(userId, async () => {
        await handleApprovalCommand(userId, action!.toLowerCase(), actionId!, reason);
      });
      return;
    }

    // Workspace selection command
    const useMatch = /^use\s+(\S+)$/i.exec(text);
    if (useMatch) {
      const wsId = useMatch[1]!;
      enqueue(userId, async () => {
        const ws = deps.workspaceStore.get(wsId);
        if (!ws || !deps.workspaceStore.getUserRole(wsId, userId)) {
          await sendText(userId, "指定されたワークスペースが見つからないか、アクセス権がありません。");
          return;
        }
        await userStore.setDefaultWorkspaceId(userId, wsId);
        await sendText(userId, `デフォルトワークスペースを「${ws.name}」に設定しました。`);
      });
      return;
    }

    enqueueAgent(text, userId);
  }

  async function handleApprovalCommand(
    userId: string,
    action: string,
    actionId: string,
    reason?: string,
  ): Promise<void> {
    const pendingAction = deps.pendingActionStore.get(actionId);
    if (!pendingAction) {
      await sendText(userId, `承認リクエスト ${actionId} が見つかりません。`);
      return;
    }

    const role = deps.workspaceStore.getUserRole(pendingAction.workspaceId, userId);
    if (role !== "owner") {
      await sendText(userId, "この操作はワークスペースオーナーのみ実行できます。");
      return;
    }

    if (action === "approve") {
      const requesterRole = deps.workspaceStore.getUserRole(pendingAction.workspaceId, pendingAction.requesterId);
      if (!requesterRole || !userStore.isActive(pendingAction.requesterId)) {
        await sendText(userId, "リクエスト元ユーザーはすでにワークスペースのメンバーではありません。操作をキャンセルしました。");
        await deps.pendingActionStore.reject(actionId, userId, "Requester no longer a member");
        return;
      }

      const resolved = await deps.pendingActionStore.approve(actionId, userId);

      const workspace = deps.workspaceStore.get(resolved.workspaceId);
      let executionError: string | undefined;
      if (workspace) {
        const gwsExecs = getGwsExecutors(workspace.id, workspace.gwsConfigDir);
        const executor = gwsExecs.get(resolved.toolName) ?? deps.registry.executors.get(resolved.toolName);
        if (executor) {
          try {
            await executor(resolved.toolInput);
          } catch (e) {
            executionError = toErrorMessage(e);
            console.error(`[approvals] Execution after approval failed:`, e);
          }
        }
      }

      await Promise.all([
        notifyActionResult(resolved, deps.registry, userId, executionError),
        notifyActionResult(resolved, deps.registry, resolved.requesterId, executionError),
      ]);
    } else {
      const resolved = await deps.pendingActionStore.reject(actionId, userId, reason);
      await Promise.all([
        notifyActionResult(resolved, deps.registry, userId),
        notifyActionResult(resolved, deps.registry, resolved.requesterId),
      ]);
    }
  }

  function handlePostback(
    event: LinePostbackEvent,
    userId: string,
  ): void {
    if (!userStore.isActive(userId)) return;

    const data = extractPostbackData(event);

    const params = new URLSearchParams(data);
    const action = params.get("action");
    const actionId = params.get("id");
    if ((action === "approve" || action === "reject") && actionId) {
      enqueue(userId, async () => {
        await handleApprovalCommand(userId, action, actionId);
      });
      return;
    }

    enqueueAgent(
      `[ポストバック] ユーザーがボタンを押しました。データ: ${data}`,
      userId,
    );
  }

  function routeEvent(event: LineWebhookEvent): void {
    const userId = extractUserId(event);
    if (!userId) return;

    if (isFollowEvent(event)) {
      handleFollow(event, userId);
    } else if (isUnfollowEvent(event)) {
      handleUnfollow(userId);
    } else if (isTextMessageEvent(event)) {
      handleTextMessage(event, userId);
    } else if (isPostbackEvent(event)) {
      handlePostback(event, userId);
    }
  }

  // --- Route ---

  route.post("/webhook/line", async (c) => {
    const body = await c.req.text();
    const signature = c.req.header("x-line-signature");

    if (!signature) {
      return c.json({ error: "Missing signature" }, 401);
    }

    const valid = await verifyLineSignature(
      body,
      signature,
      config.lineChannelSecret,
    );
    if (!valid) {
      return c.json({ error: "Invalid signature" }, 401);
    }

    const events = parseLineEvents(body);
    for (const event of events) {
      routeEvent(event);
    }

    return c.json({ status: "ok" }, 200);
  });

  return route;
}

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
import { createLogger } from "../utils/logger.js";
import {
  LINE_PUSH_TEXT_TOOL,
  type AgentDependencies,
  type LineFollowEvent,
  type LinePostbackEvent,
  type LineMessageEvent,
  type LineWebhookEvent,
  type ToolContext,
} from "../types.js";
import type { UserStore } from "../users/store.js";

const INVITE_PATTERN = /^invite\s+(U[0-9a-f]{32})$/i;
const APPROVAL_PATTERN = /^(approve|reject)\s+(\S+)(?:\s+(.*))?$/i;

export function createLineWebhookRoute(
  deps: AgentDependencies,
  userStore: UserStore,
) {
  const log = createLogger("webhook");
  const route = new Hono();

  // --- 공통 헬퍼 ---

  async function sendText(userId: string, text: string): Promise<void> {
    const exec = deps.registry.executors.get(LINE_PUSH_TEXT_TOOL);
    if (exec) await exec({ user_id: userId, text });
  }

  // 사용자별 큐: 같은 사용자 내 순차 처리 (대화 순서 보장),
  // 다른 사용자 간 병렬 실행 (상호 차단 없음)
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
        log.error("Agent loop error", { userId, error: toErrorMessage(err) });
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
    log.debug("Task enqueued", () => ({ userId, queueSize: uq.tasks.length }));
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
    const list = workspaces.map((ws) => `- ${ws.name} (${ws.id})`).join("\n");
    await sendText(
      userId,
      `You belong to multiple workspaces. Please set a default:\n${list}\n\nSend "use <ID>" to select one.`,
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

  // --- 이벤트 핸들러 ---

  function handleFollow(
    event: LineFollowEvent,
    userId: string,
  ): void {
    // 시스템 관리자 재팔로우: 초대 확인 없이 재활성화
    if (userStore.isSystemAdmin(userId) && !userStore.isActive(userId)) {
      enqueue(userId, async () => {
        await userStore.activate(userId);
        const context = resolveContext(userId);
        if (context) {
          await runAgentLoop(
            "An admin user has re-joined. Send a welcome-back message via LINE.",
            deps,
            context,
          );
        } else {
          log.warning("System admin re-followed but has no resolvable workspace", { userId });
          await sendWorkspaceSelectionPrompt(userId);
        }
      });
    } else if (userStore.isInvited(userId)) {
      enqueue(userId, async () => {
        await userStore.activate(userId);
        const context = resolveContext(userId);
        if (context) {
          await runAgentLoop(
            "A new user has joined. Send a brief greeting and usage instructions via LINE.",
            deps,
            context,
          );
        } else {
          await sendWorkspaceSelectionPrompt(userId);
        }
      });
    } else if (!userStore.isActive(userId)) {
      log.info("Uninvited follow, ignoring", { userId });
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
    if (!userStore.isActive(userId)) {
      log.debug("Ignoring message from inactive user", () => ({ userId }));
      return;
    }

    const text = extractTextMessage(event);
    log.debug("Processing text message", () => ({ userId, preview: text.slice(0, 50) }));

    // 시스템 관리자: 워크스페이스 생성 명령
    const createWsMatch = /^create-workspace\s+(.+?)\s+(U[0-9a-f]{32})$/i.exec(text);
    if (userStore.isSystemAdmin(userId) && createWsMatch) {
      const [, wsName, ownerId] = createWsMatch;
      enqueue(userId, async () => {
        const ws = await deps.workspaceStore.create(wsName!, ownerId!);
        await sendText(
          userId,
          `Workspace "${ws.name}" (${ws.id}) has been created.\nOwner: ${ownerId}\nGWS auth: docker exec -it assistant gws auth login --config-dir ${ws.gwsConfigDir}`,
        );
      });
      return;
    }

    // 오너 초대 명령 — 결정론적 처리, Claude 판단 불필요
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
                `User ${targetId} has been invited. Report the invitation completion via LINE.`,
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
            `User ${targetId} has been invited to workspace "${ws.name}". Report the invitation completion via LINE.`,
            deps,
            context,
          );
        }
      });
      return;
    }

    // 승인/거부 명령
    const approvalMatch = APPROVAL_PATTERN.exec(text);
    if (approvalMatch) {
      const [, action, actionId, reason] = approvalMatch;
      enqueue(userId, async () => {
        await handleApprovalCommand(userId, action!.toLowerCase(), actionId!, reason);
      });
      return;
    }

    // 워크스페이스 선택 명령
    const useMatch = /^use\s+(\S+)$/i.exec(text);
    if (useMatch) {
      const wsId = useMatch[1]!;
      enqueue(userId, async () => {
        const ws = deps.workspaceStore.get(wsId);
        if (!ws || !deps.workspaceStore.getUserRole(wsId, userId)) {
          await sendText(userId, "The specified workspace was not found, or you do not have access.");
          return;
        }
        await userStore.setDefaultWorkspaceId(userId, wsId);
        await sendText(userId, `Default workspace has been set to "${ws.name}".`);
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
      await sendText(userId, `Approval request ${actionId} was not found.`);
      return;
    }

    const role = deps.workspaceStore.getUserRole(pendingAction.workspaceId, userId);
    if (role !== "owner") {
      await sendText(userId, "Only the workspace owner can perform this operation.");
      return;
    }

    if (action === "approve") {
      const requesterRole = deps.workspaceStore.getUserRole(pendingAction.workspaceId, pendingAction.requesterId);
      if (!requesterRole || !userStore.isActive(pendingAction.requesterId)) {
        await sendText(userId, "The requesting user is no longer a member of this workspace. The operation has been cancelled.");
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
            log.error("Execution after approval failed", { actionId, tool: resolved.toolName, error: toErrorMessage(e) });
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
      `[Postback] The user pressed a button. Data: ${data}`,
      userId,
    );
  }

  function routeEvent(event: LineWebhookEvent): void {
    const userId = extractUserId(event);
    if (!userId) return;

    log.debug("Routing event", () => ({ eventType: event.type, userId }));

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

  // --- 라우트 ---

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
    log.debug("Received webhook events", () => ({ count: events.length }));
    for (const event of events) {
      routeEvent(event);
    }

    return c.json({ status: "ok" }, 200);
  });

  return route;
}

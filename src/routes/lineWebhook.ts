import { Hono } from "hono";
import { createChannelTextSender } from "../agent/line-tool-adapter.js";
import { runAgentAndDeliver } from "../agent/loop.js";
import { notifyActionResult } from "../approvals/notify.js";
import {
  isActive,
  createFromFollow,
  activate as activateUser,
  deactivate as deactivateUser,
} from "../domain/user.js";
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
  type AgentDependencies,
  type AgentResult,
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

  /** 채널 outbound adapter — MCP 네이티브 스키마 + userId 주입 */
  function sendText(userId: string, text: string): Promise<void> {
    return createChannelTextSender(deps.registry.executors, userId)(text);
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

  /** System Admin 전용: 워크스페이스 컨텍스트 또는 admin 폴백 */
  function resolveContextOrAdmin(userId: string): ToolContext {
    return resolveContext(userId) ?? { userId, role: "admin" };
  }

  function enqueueAgent(prompt: string, userId: string): void {
    enqueue(userId, async () => {
      const context = resolveContext(userId);
      if (!context) {
        // System Admin + 워크스페이스 미소속 → admin 컨텍스트
        if (userStore.isSystemAdmin(userId)) {
          await runAgentAndDeliver(prompt, deps, { userId, role: "admin" });
          return;
        }
        // 일반 사용자 + 워크스페이스 미소속 → 온보딩 컨텍스트
        await runAgentAndDeliver(prompt, deps, { userId, role: "member" });
        return;
      }
      await runAgentAndDeliver(prompt, deps, context);
    });
  }

  // --- 이벤트 핸들러 ---

  // TODO: event.replyToken을 Reply API에 활용 (Push API 비용 최적화)
  function handleFollow(
    _event: LineFollowEvent,
    userId: string,
  ): void {
    // 동기 가드: 빠른 거부 (이미 active면 중복 follow)
    if (isActive(userStore.get(userId))) return;

    enqueue(userId, async () => {
      // 클로저 내부에서 재조회 — enqueue 대기 중 상태 변경 대비
      const current = userStore.get(userId);

      // 이미 active — 중복 follow 또는 다른 경로에서 활성화됨
      if (isActive(current)) return;

      if (current) {
        // 기존 사용자 재팔로우 (inactive → active)
        await userStore.set(userId, activateUser(current));
        const isAdmin = userStore.isSystemAdmin(userId);
        const context = isAdmin ? resolveContextOrAdmin(userId) : resolveContext(userId) ?? { userId, role: "member" };
        const prompt = isAdmin
          ? "An admin user has re-joined. Send a welcome-back message."
          : "A returning user has re-joined. Send a welcome-back message.";
        await runAgentAndDeliver(prompt, deps, context);
      } else {
        // 신규 사용자: 즉시 활성화 + 온보딩
        await userStore.set(userId, createFromFollow());
        await runAgentAndDeliver(
          "A new user has just joined. Greet them, introduce the service, and guide them on how to get started.",
          deps,
          { userId, role: "member" },
        );
      }
    });
  }

  function handleUnfollow(userId: string): void {
    // 동기 가드: active가 아니면 무시
    if (!isActive(userStore.get(userId))) return;

    enqueue(userId, async () => {
      const current = userStore.get(userId);
      if (!current || !isActive(current)) return;
      await userStore.set(userId, deactivateUser(current));
      clearUrgentCheckpoint(userId);
    });
  }

  function handleTextMessage(
    event: LineMessageEvent,
    userId: string,
  ): void {
    if (!isActive(userStore.get(userId))) {
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
        await sendText(userId, 
          `Workspace "${ws.name}" (${ws.id}) has been created.\nOwner: ${ownerId}\nGWS auth: docker exec -it assistant gws auth login --config-dir ${ws.gwsConfigDir}`,
        );
      });
      return;
    }

    // 초대 명령 — 워크스페이스 owner만 사용 가능
    const inviteMatch = INVITE_PATTERN.exec(text);
    if (inviteMatch) {
      const targetId = inviteMatch[1]!;
      enqueue(userId, async () => {
        const ownerWs = deps.workspaceStore.getByOwner(userId);

        if (ownerWs.length === 0) {
          await sendText(userId, "You do not own any workspaces. Create a workspace first before inviting members.");
          return;
        }

        const ws = ownerWs.length === 1 ? ownerWs[0]! : ownerWs.find((w) => w.id === userStore.getDefaultWorkspaceId(userId)) ?? ownerWs[0]!;
        await deps.workspaceStore.inviteMember(ws.id, targetId, userId);

        if (!userStore.getDefaultWorkspaceId(targetId)) {
          await userStore.setDefaultWorkspaceId(targetId, ws.id);
        }

        // owner는 반드시 워크스페이스 소속 → resolveContext 보장
        const context = resolveContext(userId)!;
        await runAgentAndDeliver(
          `User ${targetId} has been invited to workspace "${ws.name}". Report the invitation completion.`,
          deps,
          context,
        );
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

    // 승인은 워크스페이스 오너만 가능 — System Admin이라도 불가.
    // 이유: PendingAction은 오너의 Google 데이터에 대한 write이므로,
    // 해당 데이터의 소유자(오너)만이 승인 권한을 가짐.
    const role = deps.workspaceStore.getUserRole(pendingAction.workspaceId, userId);
    if (role !== "owner") {
      await sendText(userId, "Only the workspace owner can perform this operation.");
      return;
    }

    if (action === "approve") {
      const requesterRole = deps.workspaceStore.getUserRole(pendingAction.workspaceId, pendingAction.requesterId);
      if (!requesterRole || !isActive(userStore.get(pendingAction.requesterId))) {
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
    if (!isActive(userStore.get(userId))) return;

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

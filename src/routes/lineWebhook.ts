import { Hono } from "hono";
import { createChannelTextSender } from "../agent/line-tool-adapter.js";
import { runAgentAndDeliver } from "../agent/loop.js";
import { approveActionHandler, rejectActionHandler } from "../agent/system-tools.js";
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
    const lastWsId = userStore.getLastWorkspaceId(userId);
    const workspace = deps.workspaceStore.resolveWorkspace(userId, lastWsId);
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
        // 일반 사용자 + 워크스페이스 미진입 → out-stage 컨텍스트
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

    // 정규식 명령 제거 — 모든 텍스트를 에이전트 루프로 전달
    // invite, approve/reject, use 명령은 System Tool로 전환됨
    enqueueAgent(text, userId);
  }

  function handlePostback(
    event: LinePostbackEvent,
    userId: string,
  ): void {
    if (!isActive(userStore.get(userId))) return;

    const data = extractPostbackData(event);

    // approve/reject postback → System Tool 핸들러 직접 호출 (LLM 미경유)
    const params = new URLSearchParams(data);
    const action = params.get("action");
    const actionId = params.get("id");
    if ((action === "approve" || action === "reject") && actionId) {
      enqueue(userId, async () => {
        const pa = deps.pendingActionStore.get(actionId);
        if (!pa) {
          await sendText(userId, `Approval request ${actionId} was not found.`);
          return;
        }
        const context: ToolContext = { userId, workspaceId: pa.workspaceId, role: "owner" };

        if (action === "approve") {
          const signal = await approveActionHandler({ action_id: actionId }, context, deps);
          const result = JSON.parse(signal.toolResult);
          await sendText(userId, result.executionError
            ? `Approved, but execution failed: ${result.executionError}`
            : `Action ${actionId} approved and executed.`);
        } else {
          await rejectActionHandler({ action_id: actionId, reason: null }, context, deps);
          await sendText(userId, `Action ${actionId} rejected.`);
        }
      });
      return;
    }

    // 기타 postback → 에이전트 루프
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

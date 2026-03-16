import { Hono } from "hono";
import { runAgentLoop } from "../agent/loop.js";
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
import type {
  LineFollowEvent,
  LinePostbackEvent,
  LineMessageEvent,
  LineWebhookEvent,
  ToolRegistry,
} from "../types.js";
import type { UserStore } from "../users/store.js";

const INVITE_PATTERN = /^invite\s+(U[0-9a-f]{32})$/i;

export function createLineWebhookRoute(
  registry: ToolRegistry,
  userStore: UserStore,
) {
  const route = new Hono();

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

  function enqueueAgent(prompt: string, userId: string): void {
    enqueue(userId, async () => {
      await runAgentLoop(prompt, registry, userId);
    });
  }

  // --- Event Handlers ---

  function handleFollow(
    event: LineFollowEvent,
    userId: string,
  ): void {
    // Admin re-follow: reactivate without invitation check
    if (userStore.isSystemAdmin(userId) && !userStore.isActive(userId)) {
      enqueue(userId, async () => {
        await userStore.activate(userId);
        await runAgentLoop(
          "管理者ユーザーが再参加しました。おかえりなさいとLINEで伝えてください。",
          registry,
          userId,
        );
      });
    } else if (userStore.isInvited(userId)) {
      enqueue(userId, async () => {
        await userStore.activate(userId);
        await runAgentLoop(
          "新しいユーザーが参加しました。簡単な挨拶と使い方をLINEで案内してください。",
          registry,
          userId,
        );
      });
    } else if (!userStore.isActive(userId)) {
      // Uninvited user — log only, no agent loop (prevents cost attacks)
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

    // Admin invite command — deterministic, not Claude-dependent
    if (userStore.isSystemAdmin(userId)) {
      const match = INVITE_PATTERN.exec(text);
      if (match) {
        const targetId = match[1]!;
        enqueue(userId, async () => {
          await userStore.invite(targetId, userId);
          await runAgentLoop(
            `ユーザー ${targetId} を招待しました。招待完了をLINEで報告してください。`,
            registry,
            userId,
          );
        });
        return;
      }
    }

    enqueueAgent(text, userId);
  }

  function handlePostback(
    event: LinePostbackEvent,
    userId: string,
  ): void {
    if (!userStore.isActive(userId)) return;

    const data = extractPostbackData(event);
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

    // Fire-and-forget: LINE requires response within 1 second
    return c.json({ status: "ok" }, 200);
  });

  return route;
}

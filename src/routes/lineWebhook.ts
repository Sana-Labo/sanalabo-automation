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

  // Sequential queue: prevents concurrent agent loops from racing
  // over shared MCP client and avoids API rate limit spikes
  const queue: Array<() => Promise<void>> = [];
  let processing = false;

  async function processQueue() {
    if (processing) return;
    processing = true;
    while (queue.length > 0) {
      const task = queue.shift()!;
      try {
        await task();
      } catch (err) {
        console.error("[webhook] Agent loop error:", err);
      }
    }
    processing = false;
  }

  function enqueue(fn: () => Promise<void>): void {
    queue.push(fn);
    void processQueue();
  }

  function enqueueAgent(prompt: string, userId: string): void {
    enqueue(async () => {
      await runAgentLoop(prompt, registry, userId);
    });
  }

  // --- Event Handlers ---

  function handleFollow(
    event: LineFollowEvent,
    userId: string,
  ): void {
    // Admin re-follow: reactivate without invitation check
    if (userStore.isAdmin(userId) && !userStore.isActive(userId)) {
      enqueue(async () => {
        await userStore.activate(userId);
        await runAgentLoop(
          "管理者ユーザーが再参加しました。おかえりなさいとLINEで伝えてください。",
          registry,
          userId,
        );
      });
    } else if (userStore.isInvited(userId)) {
      enqueue(async () => {
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
      enqueue(async () => {
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
    if (userStore.isAdmin(userId)) {
      const match = INVITE_PATTERN.exec(text);
      if (match) {
        const targetId = match[1]!;
        enqueue(async () => {
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

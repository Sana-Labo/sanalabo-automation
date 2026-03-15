import { Hono } from "hono";
import { runAgentLoop } from "../agent/loop.js";
import { verifyLineSignature, parseLineEvents, extractTextMessage } from "../channels/line.js";
import { config } from "../config.js";
import type { LineMessageEvent, ToolRegistry } from "../types.js";

export function createLineWebhookRoute(registry: ToolRegistry) {
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

  route.post("/webhook/line", async (c) => {
    const body = await c.req.text();
    const signature = c.req.header("x-line-signature");

    if (!signature) {
      return c.json({ error: "Missing signature" }, 401);
    }

    const valid = await verifyLineSignature(body, signature, config.lineChannelSecret);
    if (!valid) {
      return c.json({ error: "Invalid signature" }, 401);
    }

    const events = parseLineEvents(body);
    const textEvents = events.filter(
      (e): e is LineMessageEvent => e.type === "message" && (e as LineMessageEvent).message?.type === "text",
    );

    for (const event of textEvents) {
      const text = extractTextMessage(event);
      queue.push(() => runAgentLoop(text, registry).then(() => {}));
    }

    // Fire-and-forget: LINE requires response within 1 second
    void processQueue();

    return c.json({ status: "ok" }, 200);
  });

  return route;
}

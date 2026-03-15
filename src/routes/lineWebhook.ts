import { Hono } from "hono";
import { runAgentLoop } from "../agent/loop.js";
import { verifyLineSignature, parseLineEvents, extractTextMessage } from "../channels/line.js";
import { config } from "../config.js";
import type { LineMessageEvent, ToolRegistry } from "../types.js";

export function createLineWebhookRoute(registry: ToolRegistry) {
  const route = new Hono();

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
      // Fire-and-forget: LINE requires response within 1 second
      runAgentLoop(text, registry).catch((err) => {
        console.error("[webhook] Agent loop error:", err);
      });
    }

    return c.json({ status: "ok" }, 200);
  });

  return route;
}

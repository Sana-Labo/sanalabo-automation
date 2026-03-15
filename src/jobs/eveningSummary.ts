import { runAgentLoop } from "../agent/loop.js";
import type { ToolRegistry } from "../types.js";

export async function eveningSummary(registry: ToolRegistry): Promise<void> {
  console.log("[cron] Running evening summary...");
  try {
    const result = await runAgentLoop(
      "今日の活動をまとめて、明日の予定と一緒にLINEで送って",
      registry,
    );
    console.log(`[cron] Evening summary done (${result.toolCalls} tool calls)`);
  } catch (err) {
    console.error("[cron] Evening summary error:", err);
  }
}

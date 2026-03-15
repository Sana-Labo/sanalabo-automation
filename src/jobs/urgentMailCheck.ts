import { runAgentLoop } from "../agent/loop.js";
import type { ToolRegistry } from "../types.js";

export async function urgentMailCheck(registry: ToolRegistry): Promise<void> {
  console.log("[cron] Running urgent mail check...");
  try {
    const result = await runAgentLoop(
      "過去30分間の重要なメールを確認して、あれば通知して",
      registry,
    );
    console.log(`[cron] Urgent mail check done (${result.toolCalls} tool calls)`);
  } catch (err) {
    console.error("[cron] Urgent mail check error:", err);
  }
}

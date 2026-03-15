import { runAgentLoop } from "../agent/loop.js";
import type { ToolRegistry } from "../types.js";

export async function morningBriefing(registry: ToolRegistry): Promise<void> {
  console.log("[cron] Running morning briefing...");
  try {
    const result = await runAgentLoop(
      "未読メールと今日の予定を確認して要約をLINEで送って",
      registry,
    );
    console.log(`[cron] Morning briefing done (${result.toolCalls} tool calls)`);
  } catch (err) {
    console.error("[cron] Morning briefing error:", err);
  }
}

import { runAgentLoop } from "../agent/loop.js";
import type { ToolRegistry } from "../types.js";

function createJob(label: string, prompt: string) {
  return async (registry: ToolRegistry): Promise<void> => {
    console.log(`[cron] Running ${label}...`);
    try {
      const result = await runAgentLoop(prompt, registry);
      console.log(`[cron] ${label} done (${result.toolCalls} tool calls)`);
    } catch (err) {
      console.error(`[cron] ${label} error:`, err);
    }
  };
}

export const morningBriefing = createJob(
  "morning briefing",
  "未読メールと今日の予定を確認して要約をLINEで送って",
);

export const urgentMailCheck = createJob(
  "urgent mail check",
  "過去30分間の重要なメールを確認して、あれば通知して",
);

export const eveningSummary = createJob(
  "evening summary",
  "今日の活動をまとめて、明日の予定と一緒にLINEで送って",
);

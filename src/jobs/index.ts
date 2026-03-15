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

export const eveningSummary = createJob(
  "evening summary",
  "今日の活動をまとめて、明日の予定と一緒にLINEで送って",
);

// urgentMailCheck: timestamp-based deduplication to prevent re-notification
let lastUrgentCheck: Date | null = null;

export async function urgentMailCheck(registry: ToolRegistry): Promise<void> {
  const label = "urgent mail check";
  console.log(`[cron] Running ${label}...`);

  const since = lastUrgentCheck ?? new Date(Date.now() - 30 * 60 * 1000);
  const checkpoint = new Date();
  const sinceEpoch = Math.floor(since.getTime() / 1000);

  const prompt = `Gmailで重要なメールを確認して(クエリ: is:important after:${sinceEpoch})。該当メールがあれば内容をLINEで通知して。なければ何もしないで。`;

  try {
    const result = await runAgentLoop(prompt, registry);
    // Only advance checkpoint on success — failure retries same period
    lastUrgentCheck = checkpoint;
    console.log(`[cron] ${label} done (${result.toolCalls} tool calls)`);
  } catch (err) {
    console.error(`[cron] ${label} error:`, err);
  }
}

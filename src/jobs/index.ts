import { runAgentLoop } from "../agent/loop.js";
import type { ToolRegistry } from "../types.js";

function createJob(label: string, prompt: string) {
  return async (registry: ToolRegistry, userId: string): Promise<void> => {
    console.log(`[cron] Running ${label} for ${userId}...`);
    try {
      const result = await runAgentLoop(prompt, registry, userId);
      console.log(`[cron] ${label} done for ${userId} (${result.toolCalls} tool calls)`);
    } catch (err) {
      console.error(`[cron] ${label} error for ${userId}:`, err);
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

// urgentMailCheck: per-user timestamp-based deduplication
const lastUrgentCheckMap = new Map<string, Date>();

/** Clear stale checkpoint so reactivated users don't skip the gap period */
export function clearUrgentCheckpoint(userId: string): void {
  lastUrgentCheckMap.delete(userId);
}

export async function urgentMailCheck(
  registry: ToolRegistry,
  userId: string,
): Promise<void> {
  const label = "urgent mail check";
  console.log(`[cron] Running ${label} for ${userId}...`);

  const since = lastUrgentCheckMap.get(userId) ?? new Date(Date.now() - 30 * 60 * 1000);
  const checkpoint = new Date();
  const sinceEpoch = Math.floor(since.getTime() / 1000);

  const prompt = `Gmailで重要なメールを確認して(クエリ: is:important after:${sinceEpoch})。該当メールがあれば内容をLINEで通知して。なければ何もしないで。`;

  try {
    const result = await runAgentLoop(prompt, registry, userId);
    // Only advance checkpoint on success — failure retries same period
    lastUrgentCheckMap.set(userId, checkpoint);
    console.log(`[cron] ${label} done for ${userId} (${result.toolCalls} tool calls)`);
  } catch (err) {
    console.error(`[cron] ${label} error for ${userId}:`, err);
  }
}

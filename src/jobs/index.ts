import { runAgentLoop } from "../agent/loop.js";
import type { AgentDependencies, ToolContext } from "../types.js";

function withJobLogging(
  label: string,
  fn: (deps: AgentDependencies, context: ToolContext) => Promise<{ toolCalls: number }>,
): (deps: AgentDependencies, context: ToolContext) => Promise<void> {
  return async (deps, context) => {
    console.log(`[cron] Running ${label} for ${context.userId}...`);
    try {
      const result = await fn(deps, context);
      console.log(`[cron] ${label} done for ${context.userId} (${result.toolCalls} tool calls)`);
    } catch (err) {
      console.error(`[cron] ${label} error for ${context.userId}:`, err);
    }
  };
}

function createJob(label: string, prompt: string) {
  return withJobLogging(label, (deps, context) =>
    runAgentLoop(prompt, deps, context),
  );
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

export const urgentMailCheck = withJobLogging("urgent mail check", async (deps, context) => {
  const since = lastUrgentCheckMap.get(context.userId) ?? new Date(Date.now() - 30 * 60 * 1000);
  const checkpoint = new Date();
  const sinceEpoch = Math.floor(since.getTime() / 1000);

  const prompt = `Gmailで重要なメールを確認して(クエリ: is:important after:${sinceEpoch})。該当メールがあれば内容をLINEで通知して。なければ no_action ツールで終了して。`;

  const result = await runAgentLoop(prompt, deps, context);
  // Only advance checkpoint on success — failure retries same period
  lastUrgentCheckMap.set(context.userId, checkpoint);
  return result;
});

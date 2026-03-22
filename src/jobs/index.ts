import { runAgentAndDeliver } from "../agent/loop.js";
import { NO_ACTION_GUIDANCE } from "../agent/system.js";
import type { AgentDependencies, AgentResult, ToolContext } from "../types.js";
import { toErrorMessage } from "../utils/error.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("cron");

function withJobLogging(
  label: string,
  fn: (deps: AgentDependencies, context: ToolContext) => Promise<AgentResult>,
): (deps: AgentDependencies, context: ToolContext) => Promise<void> {
  return async (deps, context) => {
    log.info("Running job", { job: label, userId: context.userId });
    try {
      const result = await fn(deps, context);
      log.info("Job done", { job: label, userId: context.userId, toolCalls: result.toolCalls });
    } catch (err) {
      log.error("Job error", { job: label, userId: context.userId, error: toErrorMessage(err) });
    }
  };
}

/** Cron 잡용: no_action 허용 (보고할 내용 없으면 무응답으로 종료) */
function createJob(label: string, prompt: string) {
  return withJobLogging(label, (deps, context) =>
    runAgentAndDeliver(prompt, deps, context, { allowNoAction: true }),
  );
}

export const morningBriefing = createJob(
  "morning briefing",
  `Check unread emails and today's schedule, then summarize. ${NO_ACTION_GUIDANCE}`,
);

export const eveningSummary = createJob(
  "evening summary",
  `Summarize today's activities along with tomorrow's schedule. ${NO_ACTION_GUIDANCE}`,
);

// urgentMailCheck: 사용자별 타임스탬프 기반 중복 방지
const lastUrgentCheckMap = new Map<string, Date>();

/**
 * 오래된 체크포인트를 삭제하여 재활성화된 사용자가 공백 기간을 건너뛰지 않도록 한다.
 *
 * @param userId - 체크포인트를 삭제할 사용자 ID
 */
export function clearUrgentCheckpoint(userId: string): void {
  lastUrgentCheckMap.delete(userId);
}

export const urgentMailCheck = withJobLogging("urgent mail check", async (deps, context) => {
  const since = lastUrgentCheckMap.get(context.userId) ?? new Date(Date.now() - 30 * 60 * 1000);
  const checkpoint = new Date();
  const sinceEpoch = Math.floor(since.getTime() / 1000);

  const prompt = `Check Gmail for important emails (query: is:important after:${sinceEpoch}). If any, notify the user. If none, use the no_action tool to exit.`;

  const result = await runAgentAndDeliver(prompt, deps, context, { allowNoAction: true });
  // 성공 시에만 체크포인트를 전진 — 실패 시 동일 기간을 재시도
  lastUrgentCheckMap.set(context.userId, checkpoint);
  return result;
});

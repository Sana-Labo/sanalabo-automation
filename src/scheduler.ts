import { Cron } from "croner";
import { morningBriefing, urgentMailCheck, eveningSummary } from "./jobs/index.js";
import type { AgentDependencies, ToolContext } from "./types.js";
import type { UserStore } from "./users/store.js";
import { createLogger } from "./utils/logger.js";
import { toErrorMessage } from "./utils/error.js";

const log = createLogger("scheduler");

async function forAllWorkspaceUsers(
  deps: AgentDependencies,
  userStore: UserStore,
  jobFn: (deps: AgentDependencies, context: ToolContext) => Promise<void>,
): Promise<void> {
  const workspaces = deps.workspaceStore.getAll()
    .filter((ws) => ws.gwsAuthenticated);

  await Promise.allSettled(
    workspaces.map(async (ws) => {
      const activeMembers = Object.entries(ws.members)
        .filter(([userId]) => userStore.isActive(userId));

      const results = await Promise.allSettled(
        activeMembers.map(([userId, m]) =>
          jobFn(deps, { userId, workspaceId: ws.id, role: m.role }),
        ),
      );

      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        if (r.status === "rejected") {
          log.error("Job failure", {
            userId: activeMembers[i]![0], workspaceId: ws.id, error: toErrorMessage(r.reason),
          });
        }
      }
    }),
  );
}

export function startScheduler(
  deps: AgentDependencies,
  userStore: UserStore,
): Cron[] {
  const tz = "Asia/Tokyo";

  const jobs = [
    new Cron("0 8 * * 1-5", { timezone: tz, protect: true }, async () => {
      await forAllWorkspaceUsers(deps, userStore, morningBriefing);
    }),
    new Cron("*/30 8-22 * * *", { timezone: tz, protect: true }, async () => {
      await forAllWorkspaceUsers(deps, userStore, urgentMailCheck);
    }),
    new Cron("0 21 * * 1-5", { timezone: tz, protect: true }, async () => {
      await forAllWorkspaceUsers(deps, userStore, eveningSummary);
    }),
    // 매시간 만료된 PendingAction 처리 + 오래된 해결 건 삭제
    new Cron("0 * * * *", { timezone: tz }, async () => {
      const expired = await deps.pendingActionStore.expireOlderThan(24);
      if (expired > 0) log.info("Expired pending actions", { count: expired });
      const purged = await deps.pendingActionStore.purgeResolved(7);
      if (purged > 0) log.info("Purged resolved actions", { count: purged, olderThanDays: 7 });
    }),
  ];

  log.info("Cron jobs started", { timezone: tz });
  log.info("  - Morning briefing: 0 8 * * 1-5");
  log.info("  - Urgent mail check: */30 8-22 * * *");
  log.info("  - Evening summary: 0 21 * * 1-5");
  log.info("  - Pending action expiry: 0 * * * *");

  return jobs;
}

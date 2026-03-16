import { Cron } from "croner";
import { morningBriefing, urgentMailCheck, eveningSummary } from "./jobs/index.js";
import type { AgentDependencies, ToolContext } from "./types.js";
import type { UserStore } from "./users/store.js";

async function forAllWorkspaceUsers(
  deps: AgentDependencies,
  userStore: UserStore,
  jobFn: (deps: AgentDependencies, context: ToolContext) => Promise<void>,
): Promise<void> {
  const workspaces = deps.workspaceStore.getAll();

  for (const ws of workspaces) {
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
        console.error(
          `[scheduler] Job failure for ${activeMembers[i]![0]} in workspace ${ws.id}:`,
          r.reason,
        );
      }
    }
  }
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
    // Expire stale pending actions every hour
    new Cron("0 * * * *", { timezone: tz }, async () => {
      const expired = await deps.pendingActionStore.expireOlderThan(24);
      if (expired > 0) {
        console.log(`[approvals] Expired ${expired} pending actions`);
      }
    }),
  ];

  console.log("[scheduler] Cron jobs started (Asia/Tokyo)");
  console.log("[scheduler]   - Morning briefing: 0 8 * * 1-5");
  console.log("[scheduler]   - Urgent mail check: */30 8-22 * * *");
  console.log("[scheduler]   - Evening summary: 0 21 * * 1-5");
  console.log("[scheduler]   - Pending action expiry: 0 * * * *");

  return jobs;
}

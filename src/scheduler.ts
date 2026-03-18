import { Cron } from "croner";
import { morningBriefing, urgentMailCheck, eveningSummary } from "./jobs/index.js";
import type { AgentDependencies, ToolContext } from "./types.js";
import type { UserStore } from "./users/store.js";
import { toErrorMessage } from "./utils/error.js";
import { createLogger } from "./utils/logger.js";

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

/** 크론 잡 스케줄 정의 — Cron 생성과 시작 로깅의 단일 출처 */
interface ScheduleDef {
  name: string;
  cron: string;
  protect?: boolean;
  run: () => Promise<void>;
}

export function startScheduler(
  deps: AgentDependencies,
  userStore: UserStore,
): Cron[] {
  const tz = "Asia/Tokyo";

  const schedules: ScheduleDef[] = [
    { name: "morningBriefing", cron: "0 8 * * 1-5", protect: true,
      run: () => forAllWorkspaceUsers(deps, userStore, morningBriefing) },
    { name: "urgentMailCheck", cron: "*/30 8-22 * * *", protect: true,
      run: () => forAllWorkspaceUsers(deps, userStore, urgentMailCheck) },
    { name: "eveningSummary", cron: "0 21 * * 1-5", protect: true,
      run: () => forAllWorkspaceUsers(deps, userStore, eveningSummary) },
    { name: "pendingActionExpiry", cron: "0 * * * *",
      run: async () => {
        const expired = await deps.pendingActionStore.expireOlderThan(24);
        if (expired > 0) log.info("Expired pending actions", { count: expired });
        const purged = await deps.pendingActionStore.purgeResolved(7);
        if (purged > 0) log.info("Purged resolved actions", { count: purged, olderThanDays: 7 });
      } },
  ];

  const jobs = schedules.map((s) =>
    new Cron(s.cron, { timezone: tz, protect: s.protect ?? false }, s.run),
  );

  log.info("Cron jobs started", {
    timezone: tz,
    schedules: schedules.map((s) => ({ name: s.name, cron: s.cron })),
  });

  return jobs;
}

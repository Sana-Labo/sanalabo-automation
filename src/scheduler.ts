import { Cron } from "croner";
import { morningBriefing, urgentMailCheck, eveningSummary } from "./jobs/index.js";
import type { ToolRegistry } from "./types.js";
import type { UserStore } from "./users/store.js";

async function forEachActiveUser(
  userStore: UserStore,
  jobFn: (registry: ToolRegistry, userId: string) => Promise<void>,
  registry: ToolRegistry,
): Promise<void> {
  const users = userStore.getActiveUsers();
  for (const userId of users) {
    await jobFn(registry, userId);
  }
}

export function startScheduler(
  registry: ToolRegistry,
  userStore: UserStore,
): Cron[] {
  const tz = "Asia/Tokyo";

  const jobs = [
    new Cron("0 8 * * 1-5", { timezone: tz, protect: true }, async () => {
      await forEachActiveUser(userStore, morningBriefing, registry);
    }),
    new Cron("*/30 8-22 * * *", { timezone: tz, protect: true }, async () => {
      await forEachActiveUser(userStore, urgentMailCheck, registry);
    }),
    new Cron("0 21 * * 1-5", { timezone: tz, protect: true }, async () => {
      await forEachActiveUser(userStore, eveningSummary, registry);
    }),
  ];

  console.log("[scheduler] Cron jobs started (Asia/Tokyo)");
  console.log("[scheduler]   - Morning briefing: 0 8 * * 1-5");
  console.log("[scheduler]   - Urgent mail check: */30 8-22 * * *");
  console.log("[scheduler]   - Evening summary: 0 21 * * 1-5");

  return jobs;
}

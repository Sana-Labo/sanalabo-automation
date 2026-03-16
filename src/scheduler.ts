import { Cron } from "croner";
import { morningBriefing, urgentMailCheck, eveningSummary } from "./jobs/index.js";
import type { ToolRegistry } from "./types.js";
import type { UserStore } from "./users/store.js";

async function forAllActiveUsers(
  userStore: UserStore,
  jobFn: (registry: ToolRegistry, userId: string) => Promise<void>,
  registry: ToolRegistry,
): Promise<void> {
  const users = userStore.getActiveUsers();
  const results = await Promise.allSettled(
    users.map((userId) => jobFn(registry, userId)),
  );
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.status === "rejected") {
      console.error(`[scheduler] Unexpected job failure for ${users[i]}:`, r.reason);
    }
  }
}

export function startScheduler(
  registry: ToolRegistry,
  userStore: UserStore,
): Cron[] {
  const tz = "Asia/Tokyo";

  const jobs = [
    new Cron("0 8 * * 1-5", { timezone: tz, protect: true }, async () => {
      await forAllActiveUsers(userStore, morningBriefing, registry);
    }),
    new Cron("*/30 8-22 * * *", { timezone: tz, protect: true }, async () => {
      await forAllActiveUsers(userStore, urgentMailCheck, registry);
    }),
    new Cron("0 21 * * 1-5", { timezone: tz, protect: true }, async () => {
      await forAllActiveUsers(userStore, eveningSummary, registry);
    }),
  ];

  console.log("[scheduler] Cron jobs started (Asia/Tokyo)");
  console.log("[scheduler]   - Morning briefing: 0 8 * * 1-5");
  console.log("[scheduler]   - Urgent mail check: */30 8-22 * * *");
  console.log("[scheduler]   - Evening summary: 0 21 * * 1-5");

  return jobs;
}

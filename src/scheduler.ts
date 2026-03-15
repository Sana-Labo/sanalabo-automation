import { Cron } from "croner";
import { morningBriefing, urgentMailCheck, eveningSummary } from "./jobs/index.js";
import type { ToolRegistry } from "./types.js";

export function startScheduler(registry: ToolRegistry): Cron[] {
  const tz = "Asia/Tokyo";

  const jobs = [
    new Cron("0 8 * * 1-5", { timezone: tz, protect: true }, async () => {
      await morningBriefing(registry);
    }),
    new Cron("*/30 8-22 * * *", { timezone: tz, protect: true }, async () => {
      await urgentMailCheck(registry);
    }),
    new Cron("0 21 * * 1-5", { timezone: tz, protect: true }, async () => {
      await eveningSummary(registry);
    }),
  ];

  console.log("[scheduler] Cron jobs started (Asia/Tokyo)");
  console.log("[scheduler]   - Morning briefing: 0 8 * * 1-5");
  console.log("[scheduler]   - Urgent mail check: */30 8-22 * * *");
  console.log("[scheduler]   - Evening summary: 0 21 * * 1-5");

  return jobs;
}

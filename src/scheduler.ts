import { Cron } from "croner";
import { morningBriefing } from "./jobs/morningBriefing.js";
import { urgentMailCheck } from "./jobs/urgentMailCheck.js";
import { eveningSummary } from "./jobs/eveningSummary.js";
import type { ToolRegistry } from "./types.js";

export function startScheduler(registry: ToolRegistry): Cron[] {
  const tz = "Asia/Tokyo";

  const jobs = [
    new Cron("0 8 * * 1-5", { timezone: tz }, () => {
      morningBriefing(registry);
    }),
    new Cron("*/30 8-22 * * *", { timezone: tz }, () => {
      urgentMailCheck(registry);
    }),
    new Cron("0 21 * * 1-5", { timezone: tz }, () => {
      eveningSummary(registry);
    }),
  ];

  console.log("[scheduler] Cron jobs started (Asia/Tokyo)");
  console.log("[scheduler]   - Morning briefing: 0 8 * * 1-5");
  console.log("[scheduler]   - Urgent mail check: */30 8-22 * * *");
  console.log("[scheduler]   - Evening summary: 0 21 * * 1-5");

  return jobs;
}

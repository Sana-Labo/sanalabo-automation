/**
 * GWS 도구 정의 — 서비스별 파일의 통합 re-export
 *
 * Gmail(7), Calendar(4), Drive(4) = 15개 GwsToolDefinition.
 * Zod 스키마가 단일 출처.
 */
import type { GwsToolDefinition } from "../../agent/tool-definition.js";
import { gmailToolDefinitions } from "./gmail-tools.js";
import { calendarToolDefinitions } from "./calendar-tools.js";
import { driveToolDefinitions } from "./drive-tools.js";

/** 모든 GWS 도구 정의 */
export const gwsToolDefinitions: readonly GwsToolDefinition<any>[] = [
  ...gmailToolDefinitions,
  ...calendarToolDefinitions,
  ...driveToolDefinitions,
];

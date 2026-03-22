/**
 * GWS 도구 정의 — 서비스별 파일의 통합 re-export
 *
 * Gmail(7), Calendar(4), Drive(4) = 15개 GwsToolDefinition.
 * Zod 스키마가 단일 출처. 레거시 gwsTools(Anthropic.Tool[])도 하위 호환용으로 export.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { GwsToolDefinition } from "../../agent/tool-definition.js";
import { toAnthropicTool } from "../../agent/tool-definition.js";
import { gmailToolDefinitions } from "./gmail-tools.js";
import { calendarToolDefinitions } from "./calendar-tools.js";
import { driveToolDefinitions } from "./drive-tools.js";

/** 모든 GWS 도구 정의 (새 구조) */
export const gwsToolDefinitions: readonly GwsToolDefinition<any>[] = [
  ...gmailToolDefinitions,
  ...calendarToolDefinitions,
  ...driveToolDefinitions,
];

/**
 * @deprecated 레거시 정리 시 제거. gwsToolDefinitions + toAnthropicTool 사용
 *
 * Strict budget: system(8) + infra(1) = 9/20. GWS는 non-strict (Zod 검증).
 */
export const gwsTools: Anthropic.Tool[] = gwsToolDefinitions.map((d) => toAnthropicTool(d));

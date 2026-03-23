/**
 * Infra Tool — 에이전트 루프 제어 도구
 *
 * 동기 실행, 외부 시스템 호출 없음. exitLoop으로 루프 즉시 종료 가능.
 * Zod 스키마가 단일 출처. strict: true (constrained decoding).
 */
import { z } from "zod";
import { createLogger } from "../utils/logger.js";
import { infraTool, type InfraToolDefinition } from "./tool-definition.js";

const log = createLogger("agent");

// --- Zod 스키마 ---

const noActionSchema = z.object({
  reason: z.string().describe("Reason for no notification (for logging)"),
});

// --- ToolDefinition ---

/** no_action 도구 정의 — Zod 스키마 단일 출처 */
const noActionDef = infraTool({
  name: "no_action",
  description:
    "Call this tool when there is nothing to report. Calling this tool ends the task without sending any message to the user.",
  inputSchema: noActionSchema,
  handler(input) {
    log.info("no_action", { reason: input.reason });
    return {
      toolResult: "no_action acknowledged",
      exitLoop: true,
      exitText: "",
    };
  },
});

/** 모든 Infra 도구 정의 */
export const infraToolDefinitions: readonly InfraToolDefinition<unknown>[] = [
  noActionDef as InfraToolDefinition<unknown>,
];

/**
 * Infra Tool — 에이전트 루프 제어 도구
 *
 * 동기 실행, 외부 시스템 호출 없음. exitLoop으로 루프 즉시 종료 가능.
 * Zod 스키마가 단일 출처. strict: true (constrained decoding).
 */
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type { InternalToolSignal, InternalToolEntry, ToolContext } from "../types.js";
import { createLogger } from "../utils/logger.js";
import { toAnthropicTool, type InfraToolDefinition } from "./tool-definition.js";

const log = createLogger("agent");

// --- 타입 ---

/** 인프라 도구 시그널 — 루프 제어 필드 확장 */
export interface InfraToolSignal extends InternalToolSignal {
  /** true면 루프 즉시 종료 */
  exitLoop?: boolean;
  /** exitLoop 시 AgentResult.text (exitLoop: true일 때 필수) */
  exitText: string;
}

/** 인프라 도구 핸들러 (동기 — 외부 시스템 호출 없음) */
export type InfraToolHandler = (
  input: Record<string, unknown>,
  context: ToolContext,
) => InfraToolSignal;

/** 인프라 도구 등록 엔트리 */
export type InfraToolEntry = InternalToolEntry<InfraToolHandler>;

// --- Zod 스키마 ---

const noActionSchema = z.object({
  reason: z.string().describe("Reason for no notification (for logging)"),
});

// --- ToolDefinition (새 구조) ---

/** no_action 도구 정의 — Zod 스키마 단일 출처 */
const noActionDef: InfraToolDefinition<z.infer<typeof noActionSchema>> = {
  name: "no_action",
  strict: true,
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
};

/** 모든 Infra 도구 정의 (새 구조) */
export const infraToolDefinitions: readonly InfraToolDefinition<unknown>[] = [
  noActionDef as InfraToolDefinition<unknown>,
];

// --- 레거시 호환 (레거시 정리 시 제거 예정) ---

const legacyEntry: InfraToolEntry = {
  def: toAnthropicTool(noActionDef),
  handler(input, context) {
    // 레거시 핸들러: Zod 파싱 없이 기존 패턴 유지
    const reason = (input.reason as string) ?? "";
    log.info("no_action", { reason });
    return {
      toolResult: "no_action acknowledged",
      exitLoop: true,
      exitText: "",
    };
  },
};

const entries: InfraToolEntry[] = [legacyEntry];

/** @deprecated 레거시 정리 시 제거. infraToolDefinitions 사용 */
export const infraTools: ReadonlyMap<string, InfraToolEntry> = new Map(
  entries.map((e) => [e.def.name, e]),
);

/** @deprecated 레거시 정리 시 제거. infraToolDefinitions + toAnthropicTool 사용 */
export const infraToolDefs: readonly Anthropic.Tool[] = entries.map((e) => e.def);

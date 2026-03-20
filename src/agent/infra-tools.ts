import type Anthropic from "@anthropic-ai/sdk";
import type { InternalToolSignal, InternalToolEntry, ToolContext } from "../types.js";
import { createLogger } from "../utils/logger.js";

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

// --- 엔트리 ---

const noAction: InfraToolEntry = {
  def: {
    name: "no_action",
    strict: true,
    description:
      "Call this tool when there is nothing to report. Calling this tool ends the task without sending any message to the user.",
    input_schema: {
      type: "object" as const,
      properties: {
        reason: {
          type: "string",
          description: "Reason for no notification (for logging)",
        },
      },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  handler(input) {
    const reason = (input.reason as string) ?? "";
    log.info("no_action", { reason });
    return {
      toolResult: "no_action acknowledged",
      exitLoop: true,
      exitText: "",
    };
  },
};

// --- 레지스트리 ---

const entries: InfraToolEntry[] = [noAction];

/** 이름 키 Map (O(1) lookup) */
export const infraTools: ReadonlyMap<string, InfraToolEntry> = new Map(
  entries.map((e) => [e.def.name, e]),
);

/** Claude에 보낼 도구 정의 배열 */
export const infraToolDefs: readonly Anthropic.Tool[] = entries.map((e) => e.def);

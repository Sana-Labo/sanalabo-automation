import type Anthropic from "@anthropic-ai/sdk";
import type { ToolContext } from "../types.js";

// --- Types ---

/** 인프라 도구 핸들러가 루프에 반환하는 시그널 */
export interface InfraToolSignal {
  /** Claude에 반환할 tool_result content */
  toolResult: string;
  /** true면 루프 즉시 종료 */
  exitLoop?: boolean;
  /** exitLoop 시 AgentResult.text (exitLoop: true일 때 필수) */
  exitText: string;
  /** delivery 상태 갱신 (ensureDelivery 스킵용) */
  delivery?: "pushed" | "no_action";
}

/** 인프라 도구 핸들러 (동기 — 외부 시스템 호출 없음) */
export type InfraToolHandler = (
  input: Record<string, unknown>,
  context: ToolContext,
) => InfraToolSignal;

/** 인프라 도구 등록 엔트리 */
export interface InfraToolEntry {
  def: Anthropic.Tool;
  handler: InfraToolHandler;
}

// --- Entries ---

const noAction: InfraToolEntry = {
  def: {
    name: "no_action",
    description:
      "報告すべき内容がない場合に呼び出してください。このツールを呼ぶと、ユーザーへのメッセージ送信なしでタスクを終了します。",
    input_schema: {
      type: "object" as const,
      properties: {
        reason: {
          type: "string",
          description: "通知不要の理由（ログ用）",
        },
      },
      required: ["reason"],
    },
  },
  handler(input) {
    const reason = (input.reason as string) ?? "";
    console.log(`[agent] no_action: ${reason}`);
    return {
      toolResult: "no_action acknowledged",
      exitLoop: true,
      exitText: "",
      delivery: "no_action",
    };
  },
};

// --- Registry ---

const entries: InfraToolEntry[] = [noAction];

/** 이름 키 Map (O(1) lookup) */
export const infraTools: ReadonlyMap<string, InfraToolEntry> = new Map(
  entries.map((e) => [e.def.name, e]),
);

/** Claude에 보낼 도구 정의 배열 */
export const infraToolDefs: readonly Anthropic.Tool[] = entries.map((e) => e.def);

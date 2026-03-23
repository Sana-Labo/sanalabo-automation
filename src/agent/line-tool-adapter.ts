/**
 * LINE 도구 스키마 단순화 + 입력 변환 래퍼
 *
 * LLM에는 flat한 단순 스키마를 노출하고,
 * 실행 시 MCP 네이티브 스키마로 변환 + userId 주입.
 *
 * - LLM 경유 (loop.ts): 단순화 입력 → adapter 변환 → MCP Pool
 * - 코드 직접 (notify.ts 등): buildTextPayload/buildFlexPayload 헬퍼 사용
 *
 * Zod 스키마가 단일 출처. push_text_message: Zod 검증 (strict 제거).
 */
import { z } from "zod";
import { LINE_PUSH_TEXT_TOOL, LINE_PUSH_FLEX_TOOL, type ToolExecutor } from "../types.js";
import { createLogger } from "../utils/logger.js";
import type { LineToolDefinition } from "./tool-definition.js";

const log = createLogger("channel");

// --- Zod 스키마 ---

const pushTextSchema = z.object({
  text: z.string().describe("The text message to send"),
});

const pushFlexSchema = z.object({
  altText: z.string().describe("Alternative text shown in notifications"),
  contents: z.record(z.string(), z.unknown()).describe("Flex Message container (bubble or carousel)"),
});

// --- MCP 페이로드 헬퍼 ---

/**
 * MCP 네이티브 스키마용 텍스트 메시지 페이로드 생성
 *
 * userId + text → MCP `push_text_message` 입력 형식.
 * notify.ts, system-tools.ts 등 코드에서 직접 호출할 때 사용.
 */
export function buildTextPayload(userId: string, text: string): Record<string, unknown> {
  return {
    userId,
    message: { type: "text", text },
  };
}

/**
 * MCP 네이티브 스키마용 Flex 메시지 페이로드 생성
 *
 * userId + altText + contents → MCP `push_flex_message` 입력 형식.
 */
export function buildFlexPayload(
  userId: string,
  altText: string,
  contents: Record<string, unknown>,
): Record<string, unknown> {
  return {
    userId,
    message: { type: "flex", altText, contents },
  };
}

// --- ToolDefinition ---

const pushTextDef: LineToolDefinition<z.infer<typeof pushTextSchema>> = {
  name: LINE_PUSH_TEXT_TOOL,
  category: "skill",
  // strict 제거: Zod 검증으로 전환 (비용 효율적, 스키마 극단적 단순)
  description:
    "Send a text message to the user via LINE. Keep messages under 2000 characters.",
  inputSchema: pushTextSchema,
  createExecutor: (deps) => async (input) => {
    return deps.origExecutor(buildTextPayload(deps.userId, input.text));
  },
};

const pushFlexDef: LineToolDefinition<z.infer<typeof pushFlexSchema>> = {
  name: LINE_PUSH_FLEX_TOOL,
  category: "skill",
  description:
    "Send a Flex Message to the user via LINE. Use for rich, structured content.",
  inputSchema: pushFlexSchema,
  createExecutor: (deps) => async (input) => {
    return deps.origExecutor(buildFlexPayload(deps.userId, input.altText, input.contents));
  },
};

/** LINE 도구 정의 배열 */
export const lineToolDefinitions: readonly LineToolDefinition<any>[] = [
  pushTextDef, pushFlexDef,
];

/**
 * 원본 MCP executor를 래핑하여 단순화 입력 → MCP 네이티브 스키마로 변환
 *
 * @param origExecutors - MCP Pool에서 제공하는 원본 executor Map
 * @param userId - LINE userId (코드에서 강제 주입)
 * @returns 래핑된 executor Map (LLM 경유 도구 호출용)
 */
export function createLineExecutors(
  origExecutors: Map<string, ToolExecutor>,
  userId: string,
): Map<string, ToolExecutor> {
  const wrapped = new Map<string, ToolExecutor>();

  for (const def of lineToolDefinitions) {
    const origExec = origExecutors.get(def.name);
    if (origExec) {
      const typedExecutor = def.createExecutor({ origExecutor: origExec, userId });
      wrapped.set(def.name, (input) => typedExecutor(input as any));
    }
  }

  return wrapped;
}

/**
 * 채널 outbound adapter용 텍스트 전송 함수 생성
 *
 * MCP 네이티브 스키마로 변환 + userId 주입.
 * webhook/cron 등 호출자가 에이전트 루프 종료 후 채널 전달에 사용.
 *
 * @param origExecutors - MCP Pool에서 제공하는 원본 executor Map
 * @param userId - LINE userId (코드에서 강제 주입)
 * @returns 텍스트 전송 함수 (빈 문자열이면 전송하지 않음)
 */
export function createChannelTextSender(
  origExecutors: Map<string, ToolExecutor>,
  userId: string,
): (text: string) => Promise<void> {
  return async (text) => {
    if (!text) return;
    const exec = origExecutors.get(LINE_PUSH_TEXT_TOOL);
    if (!exec) {
      log.warning("push_text_message executor not found — channel delivery skipped");
      return;
    }
    await exec(buildTextPayload(userId, text));
  };
}

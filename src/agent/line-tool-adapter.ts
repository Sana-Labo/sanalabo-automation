/**
 * LINE 도구 스키마 단순화 + 입력 변환 래퍼
 *
 * LLM에는 flat한 단순 스키마를 노출하고,
 * 실행 시 MCP 네이티브 스키마로 변환 + userId 주입.
 *
 * - LLM 경유 (loop.ts): 단순화 입력 → adapter 변환 → MCP Pool
 * - 코드 직접 (notify.ts 등): 원본 executor 직접 호출 (변경 없음)
 */
import type Anthropic from "@anthropic-ai/sdk";
import { LINE_PUSH_TEXT_TOOL, LINE_PUSH_FLEX_TOOL, type ToolExecutor } from "../types.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("channel");

/** LLM에 노출할 LINE 채널 스킬 도구 스키마 (strict: true) */
export const LINE_CHANNEL_SKILL_TOOLS: Anthropic.Tool[] = [
  {
    name: LINE_PUSH_TEXT_TOOL,
    strict: true,
    description:
      "Send a text message to the user via LINE. Keep messages under 2000 characters.",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The text message to send",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: LINE_PUSH_FLEX_TOOL,
    description:
      "Send a Flex Message to the user via LINE. Use for rich, structured content.",
    input_schema: {
      type: "object",
      properties: {
        altText: {
          type: "string",
          description: "Alternative text shown in notifications",
        },
        contents: {
          type: "object",
          description: "Flex Message container (bubble or carousel)",
        },
      },
      required: ["altText", "contents"],
    },
  },
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

  const textExec = origExecutors.get(LINE_PUSH_TEXT_TOOL);
  if (textExec) {
    wrapped.set(LINE_PUSH_TEXT_TOOL, async (input) => {
      return textExec({
        userId,
        message: { type: "text", text: input.text },
      });
    });
  }

  const flexExec = origExecutors.get(LINE_PUSH_FLEX_TOOL);
  if (flexExec) {
    wrapped.set(LINE_PUSH_FLEX_TOOL, async (input) => {
      return flexExec({
        userId,
        message: { type: "flex", altText: input.altText, contents: input.contents },
      });
    });
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
    await exec({
      userId,
      message: { type: "text", text },
    });
  };
}

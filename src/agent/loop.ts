/**
 * 에이전트 루프 — Claude API tool_use 기반 자율 실행
 *
 * 오케스트레이터: LLM API 호출 + 메시지 관리 + 턴 제어.
 * 도구 디스패치는 dispatch.ts에 위임.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { client } from "./api-client.js";
import { resolveMaxTokens, MAX_TOKENS_RESUME_PROMPT } from "./api-errors.js";
import {
  type AgentDependencies,
  type AgentResult,
  type ToolContext,
  type ToolExecutor,
  type ToolRegistry,
} from "../types.js";
import { type ToolDefinition } from "./tool-definition.js";
import { toErrorMessage } from "../utils/error.js";
import { createLogger } from "../utils/logger.js";
import { createChannelTextSender, createLineExecutors } from "./line-tool-adapter.js";
import { infraToolDefinitions } from "./infra-tools.js";
import { systemToolDefinitions } from "./system-tools.js";
import { TranscriptRecorder } from "./transcript.js";
import {
  mergeGwsExecutors,
  setupContext,
  dispatchAllTools,
  type LoopState,
  type AgentLoopOptions,
} from "./dispatch.js";
import {
  createLoggingFilter,
  createWriteInterceptFilter,
  createZodValidationFilter,
  createExecutorFilter,
} from "./filter-chain.js";

const log = createLogger("agent");

/** end_turn 응답을 JSON Schema로 강제하는 설정 */
const OUTPUT_CONFIG: Anthropic.Messages.OutputConfig = {
  format: {
    type: "json_schema",
    schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Message to send to user via LINE" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
};

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * end_turn 응답에서 JSON 파싱 → text 필드 추출
 *
 * output_config(json_schema)에 의해 `{ text: string }` 형식이 보장되지만,
 * 파싱 실패 또는 text 필드 누락 시 원본 텍스트를 폴백으로 반환.
 */
function extractJsonText(content: Anthropic.ContentBlock[]): string {
  const raw = extractText(content);
  if (!raw) return raw;
  try {
    const parsed = JSON.parse(raw) as { text?: string };
    if (typeof parsed.text === "string") return parsed.text;
    log.warning("JSON output missing text field", { keys: Object.keys(parsed) });
    return raw;
  } catch {
    log.debug("JSON output parsing failed, using raw text");
    return raw;
  }
}

// AgentLoopOptions 재export — 기존 import 호환 유지
export type { AgentLoopOptions } from "./dispatch.js";

export async function runAgentLoop(
  userMessage: string,
  deps: AgentDependencies,
  initialContext: ToolContext,
  options: AgentLoopOptions = {},
): Promise<AgentResult> {
  // --- Agent Config ---
  const model = config.agentModel;
  const maxTurns = config.agentMaxTurns;
  const maxTokens = await resolveMaxTokens(client, model, config.agentMaxTokens);

  // --- Agent Context Setup ---
  const context = initialContext;

  // [1] Context 해석
  const workspace = context.workspaceId
    ? deps.workspaceStore.get(context.workspaceId)
    : undefined;
  const userWorkspaces = context.workspaceId
    ? []
    : deps.workspaceStore.getByMember(context.userId);

  // [2] Capabilities 결정 (async — executor merge)
  const executors = new Map(deps.registry.executors);
  if (workspace) {
    await mergeGwsExecutors(executors, deps, workspace.id);
  }
  const lineExecs = createLineExecutors(deps.registry.executors, context.userId);
  for (const [name, exec] of lineExecs) {
    executors.set(name, exec);
  }

  // [3] Context setup (sync — capabilities → tools → prompt 순서 보장)
  const allDefMap = new Map<string, ToolDefinition<any>>();
  for (const def of infraToolDefinitions) allDefMap.set(def.name, def);
  for (const def of systemToolDefinitions) allDefMap.set(def.name, def);
  for (const def of deps.registry.definitions) allDefMap.set(def.name, def);

  const { systemPrompt, allTools } = setupContext(
    context, executors, allDefMap, options, workspace, userWorkspaces,
  );

  const transcript = new TranscriptRecorder(config.dataDir);
  transcript.startRun({
    userId: context.userId,
    workspaceId: context.workspaceId,
    trigger: options.trigger ?? "webhook",
    userMessage,
    systemPrompt,
  });

  const state: LoopState = { context, systemPrompt, executors, allDefMap, allTools, transcript };

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  let turns = 0;
  let maxTokenRetries = 0;
  let toolCalls = 0;
  let channelDelivered = false;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  /** 트랜스크립트 기록 완료 (fire-and-forget) */
  function finalizeTranscript(result: AgentResult): void {
    state.transcript
      .endRun({
        result,
        usage: { totalInputTokens, totalOutputTokens },
      })
      .catch((e) => {
        log.error("Failed to write transcript", { error: toErrorMessage(e) });
      });
  }

  // 필터 체인 — 루프 밖 생성 (상태 비의존 클로저 + executors Map은 in-place 변경이므로 참조 안정)
  const filters = [
    createLoggingFilter(),
    createWriteInterceptFilter(deps),
    createZodValidationFilter(),
    createExecutorFilter(state.executors),
  ];

  log.debug("Agent loop started", () => ({ userId: state.context.userId, workspaceId: state.context.workspaceId, role: state.context.role }));

  while (turns < maxTurns) {
    turns++;
    log.debug("Turn started", () => ({ turn: turns, maxTurns }));

    log.debug("Claude API request", () => ({ model, messageCount: messages.length, toolCount: state.allTools.length }));
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: state.systemPrompt,
      tools: state.allTools,
      output_config: OUTPUT_CONFIG,
      messages,
    });

    log.debug("Claude API response", () => ({ stopReason: response.stop_reason, contentBlocks: response.content.length }));

    // usage 누적
    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;

    // max_tokens — resume 프롬프트 주입으로 응답 이어가기
    if (response.stop_reason === "max_tokens") {
      state.transcript.recordTurn({
        request: { model, messageCount: messages.length, toolCount: state.allTools.length },
        response: { stopReason: "max_tokens", content: response.content },
        toolResults: [],
      });

      if (maxTokenRetries >= config.agentMaxTokenRetries) {
        const text = extractText(response.content) || "The response was too long and has been truncated.";
        log.warning("max_tokens retries exhausted", { retries: maxTokenRetries, model });
        const result: AgentResult = { text, toolCalls, channelDelivered };
        finalizeTranscript(result);
        return result;
      }

      maxTokenRetries++;
      log.info("max_tokens resume", { attempt: maxTokenRetries, limit: config.agentMaxTokenRetries, model });
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: MAX_TOKENS_RESUME_PROMPT });
      continue;
    }

    // end_turn — 도구 호출 없이 종료
    if (response.stop_reason !== "tool_use") {
      const text = extractJsonText(response.content);
      log.debug("Agent loop completed", () => ({ turns, toolCalls }));
      state.transcript.recordTurn({
        request: { model, messageCount: messages.length, toolCount: state.allTools.length },
        response: { stopReason: response.stop_reason ?? "end_turn", content: response.content },
        toolResults: [],
      });
      const result: AgentResult = { text, toolCalls, channelDelivered };
      finalizeTranscript(result);
      return result;
    }

    // tool_use — 3단계 디스패치 위임
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    const dispatchResult = await dispatchAllTools(
      toolUseBlocks,
      state,
      deps,
      options,
      {
        model,
        messageCount: messages.length,
        toolCount: state.allTools.length,
        stopReason: "tool_use",
        content: response.content,
      },
      userMessage,
      filters,
    );

    toolCalls += dispatchResult.toolCallCount;
    if (dispatchResult.channelDelivered) channelDelivered = true;

    // exitLoop 시그널 — 즉시 종료
    if (dispatchResult.exitResult) {
      const result: AgentResult = {
        text: dispatchResult.exitResult.text,
        toolCalls,
        channelDelivered,
      };
      finalizeTranscript(result);
      return result;
    }

    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: dispatchResult.results });
  }

  const text = "Reached the maximum number of tool calls. Aborting.";
  const result: AgentResult = { text, toolCalls, channelDelivered };
  finalizeTranscript(result);
  return result;
}

/**
 * 에이전트 루프 실행 + 채널 전달
 *
 * runAgentLoop 후 channelDelivered가 false이고 text가 있으면
 * 채널 어댑터를 통해 결정론적으로 전달.
 */
export async function runAgentAndDeliver(
  userMessage: string,
  deps: AgentDependencies,
  context: ToolContext,
  options: AgentLoopOptions = {},
): Promise<AgentResult> {
  const result = await runAgentLoop(userMessage, deps, context, options);
  if (!result.channelDelivered && result.text) {
    const sendText = createChannelTextSender(deps.registry.executors, context.userId);
    await sendText(result.text);
  }
  return result;
}

/** ToolRegistry 빌더 — definitions + executors 병합 */
export function buildToolRegistry(
  ...registries: { definitions: readonly ToolDefinition<any>[]; executors: Map<string, ToolExecutor> }[]
): ToolRegistry {
  const definitions: ToolDefinition<any>[] = [];
  const executors = new Map<string, ToolExecutor>();

  for (const reg of registries) {
    definitions.push(...reg.definitions);
    for (const [name, exec] of reg.executors) {
      executors.set(name, exec);
    }
  }

  return { definitions, executors };
}

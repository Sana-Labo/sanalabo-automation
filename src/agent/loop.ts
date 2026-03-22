import Anthropic from "@anthropic-ai/sdk";
import { interceptWrite } from "../approvals/interceptor.js";
import { notifyOwnerOfPending } from "../approvals/notify.js";
import { config } from "../config.js";
import {
  CHANNEL_SKILL_TOOL_NAMES,
  type AgentDependencies,
  type AgentResult,
  type ToolContext,
  type ToolExecutor,
  type ToolRegistry,
} from "../types.js";
import { toErrorMessage } from "../utils/error.js";
import { createLogger } from "../utils/logger.js";
import { infraToolDefs, infraTools } from "./infra-tools.js";
import { createChannelTextSender, createLineExecutors } from "./line-tool-adapter.js";
import { systemToolDefs, systemTools } from "./system-tools.js";
import { buildSystemPrompt } from "./system.js";

const log = createLogger("agent");

const MAX_TURNS = 15;
const MODEL = "claude-haiku-4-5-20251001";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

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
    // output_config 제약에도 불구하고 text 필드 누락 — 구조 불일치 경고
    log.warning("JSON output missing text field", { keys: Object.keys(parsed) });
    return raw;
  } catch {
    log.debug("JSON output parsing failed, using raw text");
    return raw;
  }
}

/** 에이전트 루프 옵션 */
export interface AgentLoopOptions {
  /** no_action 도구 허용 여부. cron 잡에서만 true (기본: false) */
  allowNoAction?: boolean;
}

export async function runAgentLoop(
  userMessage: string,
  deps: AgentDependencies,
  initialContext: ToolContext,
  options: AgentLoopOptions = {},
): Promise<AgentResult> {
  let context = initialContext;
  const workspace = context.workspaceId
    ? deps.workspaceStore.get(context.workspaceId)
    : undefined;
  // Out-stage 판별: 워크스페이스 미진입 시 사용자 소속 WS 조회
  const userWorkspaces = context.workspaceId
    ? []
    : deps.workspaceStore.getByMember(context.userId);
  const systemPrompt = buildSystemPrompt(context, workspace, userWorkspaces);

  // 요청별 executor 구성: 기본 레지스트리 + 워크스페이스별 GWS executor
  // LINE push 도구는 래핑 executor (단순화 입력 → MCP 네이티브 변환 + userId 주입)
  const executors = new Map(deps.registry.executors);
  if (workspace) {
    const gwsExecs = await deps.getGwsExecutors(workspace.id);
    if (gwsExecs) {
      for (const [name, exec] of gwsExecs) {
        executors.set(name, exec);
      }
    }
  }
  const lineExecs = createLineExecutors(deps.registry.executors, context.userId);
  for (const [name, exec] of lineExecs) {
    executors.set(name, exec);
  }

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  let turns = 0;
  let toolCalls = 0;
  let channelDelivered = false;

  /** executor가 존재하는 도구 + 내부 도구(infra, system)만 Claude에게 전달 */
  function buildToolList() {
    // no_action: cron 잡 전용. 사용자 대화에서는 제외하여 반드시 텍스트 응답하도록 강제
    const infra = options.allowNoAction
      ? infraToolDefs
      : infraToolDefs.filter(t => t.name !== "no_action");
    return [...deps.registry.tools, ...infra, ...systemToolDefs]
      .filter(t => executors.has(t.name) || infraTools.has(t.name) || systemTools.has(t.name));
  }
  let allTools = buildToolList();

  log.debug("Agent loop started", () => ({ userId: context.userId, workspaceId: context.workspaceId, role: context.role }));

  while (turns < MAX_TURNS) {
    turns++;
    log.debug("Turn started", () => ({ turn: turns, maxTurns: MAX_TURNS }));

    log.debug("Claude API request", () => ({ model: MODEL, messageCount: messages.length, toolCount: allTools.length }));
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      tools: allTools,
      output_config: OUTPUT_CONFIG,
      messages,
    });

    log.debug("Claude API response", () => ({ stopReason: response.stop_reason, contentBlocks: response.content.length }));

    if (response.stop_reason === "max_tokens") {
      const text = extractText(response.content) || "The response was too long and has been truncated.";
      return { text, toolCalls, channelDelivered };
    }

    if (response.stop_reason !== "tool_use") {
      // end_turn: output_config에 의해 JSON 형식 → text 필드 추출
      const text = extractJsonText(response.content);
      log.debug("Agent loop completed", () => ({ turns, toolCalls }));
      return { text, toolCalls, channelDelivered };
    }

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    // --- 3단계 디스패치 ---

    // [1단계] Infra tool 선처리: 루프 제어 (exitLoop 가능)
    const handled = new Set<string>();
    const infraToolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      const entry = infraTools.get(block.name);
      if (!entry) continue;
      toolCalls++;
      handled.add(block.id);
      log.debug("Infra tool handled", () => ({ tool: block.name, toolUseId: block.id }));
      const signal = entry.handler(
        block.input as Record<string, unknown>,
        context,
      );
      if (signal.exitLoop) {
        return { text: signal.exitText, toolCalls, channelDelivered };
      }
      // non-exit infra tool: tool_result를 메시지 히스토리에 포함
      infraToolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: signal.toolResult,
      });
    }

    // [2단계] System tool: 내부 시스템 관리 (비동기, deps 접근)
    const systemToolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      if (handled.has(block.id)) continue;
      const entry = systemTools.get(block.name);
      if (!entry) continue;
      toolCalls++;
      handled.add(block.id);
      log.debug("System tool handled", () => ({ tool: block.name, toolUseId: block.id }));
      const signal = await entry.handler(
        block.input as Record<string, unknown>,
        context,
        deps,
      );
      systemToolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: signal.toolResult,
      });

      // enter_workspace 후 executor + tools 동적 재구성 — 같은 턴에서 GWS 도구 사용 가능
      if (signal.enteredWorkspaceId) {
        const enteredWs = deps.workspaceStore.get(signal.enteredWorkspaceId);
        if (enteredWs) {
          const gwsExecs = await deps.getGwsExecutors(enteredWs.id);
          if (gwsExecs) {
            for (const [name, exec] of gwsExecs) {
              executors.set(name, exec);
            }
          }
          allTools = buildToolList();
          context = { ...context, workspaceId: enteredWs.id, role: deps.workspaceStore.getUserRole(enteredWs.id, context.userId) ?? context.role };
          log.info("Executor rebuilt after workspace entry", { workspaceId: enteredWs.id, toolCount: allTools.length });
        }
      }
    }

    // [3단계] Skill tool: 외부 시스템 통신 (handled 제외)
    const remaining = toolUseBlocks.filter((b) => !handled.has(b.id));
    const skillToolResults = await Promise.all(
      remaining.map(async (block) => {
        toolCalls++;
        log.debug("Tool call", () => ({ tool: block.name, toolUseId: block.id }));
        const toolInput = block.input as Record<string, unknown>;

        // 비오너 멤버의 write 도구 가로채기
        const interception = await interceptWrite(
          block.name,
          toolInput,
          context,
          deps.pendingActionStore,
          userMessage,
        );

        if (interception.intercepted) {
          log.debug("Write intercepted", () => ({ tool: block.name, pendingActionId: interception.pendingAction.id }));
          // 비동기로 오너에게 통지 (실패 시 로그 기록, silent drop 방지)
          notifyOwnerOfPending(
            interception.pendingAction,
            deps.registry,
            deps.workspaceStore,
          ).catch((e) => {
            log.error("Failed to notify owner of pending action", { pendingActionId: interception.pendingAction.id, error: toErrorMessage(e) });
          });

          return {
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: "This operation requires the owner's approval. An approval request has been sent.",
          };
        }

        const executor = executors.get(block.name);

        if (!executor) {
          return {
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: `Error: Unknown tool "${block.name}"`,
            is_error: true,
          };
        }

        try {
          const result = await executor(toolInput);
          log.debug("Tool succeeded", () => ({ tool: block.name, resultLength: result.length }));
          if (CHANNEL_SKILL_TOOL_NAMES.has(block.name)) {
            channelDelivered = true;
          }
          return {
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: result,
          };
        } catch (e) {
          log.debug("Tool failed", () => ({ tool: block.name, error: toErrorMessage(e) }));
          return {
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: `Error: ${toErrorMessage(e)}`,
            is_error: true,
          };
        }
      }),
    );

    const toolResults = [...infraToolResults, ...systemToolResults, ...skillToolResults];
    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });
  }

  const text = "Reached the maximum number of tool calls. Aborting.";
  return { text, toolCalls, channelDelivered };
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

export function buildToolRegistry(
  ...registries: { tools: Anthropic.Tool[]; executors: Map<string, ToolExecutor> }[]
): ToolRegistry {
  const tools: Anthropic.Tool[] = [];
  const executors = new Map<string, ToolExecutor>();

  for (const reg of registries) {
    tools.push(...reg.tools);
    for (const [name, exec] of reg.executors) {
      executors.set(name, exec);
    }
  }

  return { tools, executors };
}

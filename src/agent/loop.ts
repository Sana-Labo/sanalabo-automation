import Anthropic from "@anthropic-ai/sdk";
import { interceptWrite } from "../approvals/interceptor.js";
import { notifyOwnerOfPending } from "../approvals/notify.js";
import { config } from "../config.js";
import { getGwsExecutors } from "../skills/gws/executor.js";
import {
  LINE_PUSH_FLEX_TOOL,
  LINE_PUSH_TEXT_TOOL,
  type AgentDependencies,
  type AgentResult,
  type ToolContext,
  type ToolExecutor,
  type ToolRegistry,
} from "../types.js";
import { toErrorMessage } from "../utils/error.js";
import { createLogger } from "../utils/logger.js";
import { infraToolDefs, infraTools } from "./infra-tools.js";
import { buildSystemPrompt } from "./system.js";

const log = createLogger("agent");

const MAX_TURNS = 15;
const MODEL = "claude-haiku-4-5-20251001";
const LINE_PUSH_TOOLS = new Set([LINE_PUSH_TEXT_TOOL, LINE_PUSH_FLEX_TOOL]);

const client = new Anthropic({ apiKey: config.anthropicApiKey });

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

export async function runAgentLoop(
  userMessage: string,
  deps: AgentDependencies,
  context: ToolContext,
): Promise<AgentResult> {
  const workspace = context.workspaceId
    ? deps.workspaceStore.get(context.workspaceId)
    : undefined;
  const systemPrompt = buildSystemPrompt(context, workspace);

  // 요청별 executor 구성: 기본 레지스트리 + 워크스페이스별 GWS executor
  const executors = new Map(deps.registry.executors);
  if (workspace) {
    const gwsExecs = getGwsExecutors(workspace.id, workspace.gwsConfigDir);
    for (const [name, exec] of gwsExecs) {
      executors.set(name, exec);
    }
  }

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  let turns = 0;
  let toolCalls = 0;
  let delivery: "pending" | "pushed" | "no_action" = "pending";
  // executor가 존재하는 도구 + 인프라 도구만 Claude에게 전달
  const allTools = [...deps.registry.tools, ...infraToolDefs]
    .filter(t => executors.has(t.name) || infraTools.has(t.name));

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
      messages,
    });

    log.debug("Claude API response", () => ({ stopReason: response.stop_reason, contentBlocks: response.content.length }));

    if (response.stop_reason === "max_tokens") {
      const text = extractText(response.content) || "The response was too long and has been truncated.";
      await ensureDelivery(text);
      return { text, toolCalls };
    }

    if (response.stop_reason !== "tool_use") {
      const text = extractText(response.content);
      await ensureDelivery(text);
      log.debug("Agent loop completed", () => ({ turns, toolCalls }));
      return { text, toolCalls };
    }

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    // 인프라 도구 선처리: 스킬 도구보다 먼저 디스패치
    const handled = new Set<string>();
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
      if (signal.delivery) delivery = signal.delivery;
      if (signal.exitLoop) {
        return { text: signal.exitText, toolCalls };
      }
    }

    // 이미 처리된 블록을 제외한 나머지 도구 실행
    const remaining = toolUseBlocks.filter((b) => !handled.has(b.id));
    const toolResults = await Promise.all(
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
          const isLinePush = LINE_PUSH_TOOLS.has(block.name);
          // 이중 안전장치: LINE push 도구의 user_id를 코드에서 강제 주입
          if (isLinePush) {
            toolInput.user_id = context.userId;
            log.debug("Injected userId for LINE push", () => ({ tool: block.name, userId: context.userId }));
          }
          const result = await executor(toolInput);
          log.debug("Tool succeeded", () => ({ tool: block.name, resultLength: result.length }));
          // push 성공 시에만 설정 — 실패 시 ensureDelivery 폴백이 재시도할 수 있음
          if (isLinePush) {
            delivery = "pushed";
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

    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });
  }

  const text = "Reached the maximum number of tool calls. Aborting.";
  await ensureDelivery(text);
  return { text, toolCalls };

  /** 에이전트가 직접 push하지 않은 경우 LINE으로 응답 전송 */
  async function ensureDelivery(text: string): Promise<void> {
    if (delivery !== "pending" || !text) return;
    const exec = executors.get(LINE_PUSH_TEXT_TOOL);
    if (!exec) {
      log.warning("push_text_message executor not found — response not delivered");
      return;
    }
    try {
      await exec({ user_id: context.userId, text });
      delivery = "pushed";
    } catch (e) {
      log.error("ensureDelivery failed", { error: toErrorMessage(e) });
    }
  }
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

import Anthropic from "@anthropic-ai/sdk";
import { interceptWrite } from "../approvals/interceptor.js";
import { notifyOwnerOfPending } from "../approvals/notify.js";
import { config } from "../config.js";
import { getGwsExecutors } from "../skills/gws/executor.js";
import type {
  AgentDependencies,
  AgentResult,
  ToolContext,
  ToolExecutor,
  ToolRegistry,
} from "../types.js";
import { toErrorMessage } from "../utils/error.js";
import { createLogger } from "../utils/logger.js";
import { buildSystemPrompt } from "./system.js";

const log = createLogger("agent");

const MAX_TURNS = 15;
const MODEL = "claude-haiku-4-5-20251001";
const LINE_PUSH_PREFIX = "push_";

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
  const workspace = deps.workspaceStore.get(context.workspaceId);
  const systemPrompt = buildSystemPrompt(context, workspace);

  // 요청별 executor 구성: 기본 레지스트리 + 워크스페이스별 GWS executor
  const executors = new Map(deps.registry.executors);
  if (workspace) {
    const gwsExecs = getGwsExecutors(workspace.id, workspace.gwsConfigDir);
    for (const [name, exec] of gwsExecs) {
      executors.set(name, exec);
    }
  }

  log.debug("Agent loop started", { userId: context.userId, workspaceId: context.workspaceId, role: context.role });

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  let turns = 0;
  let toolCalls = 0;

  while (turns < MAX_TURNS) {
    turns++;
    log.debug("Turn started", { turn: turns, maxTurns: MAX_TURNS });

    log.debug("Claude API request", { model: MODEL, messageCount: messages.length, toolCount: deps.registry.tools.length });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      tools: deps.registry.tools,
      messages,
    });

    log.debug("Claude API response", { stopReason: response.stop_reason, contentBlocks: response.content.length });

    if (response.stop_reason === "max_tokens") {
      const text = extractText(response.content);
      return { text: text || "The response was too long and has been truncated.", toolCalls };
    }

    if (response.stop_reason !== "tool_use") {
      log.debug("Agent loop completed", { turns, toolCalls });
      return { text: extractText(response.content), toolCalls };
    }

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    const toolResults = await Promise.all(
      toolUseBlocks.map(async (block) => {
        toolCalls++;
        log.debug("Tool call", { tool: block.name, toolUseId: block.id });
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
          log.debug("Write intercepted", { tool: block.name, pendingActionId: interception.pendingAction.id });
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
          // 이중 안전장치: LINE push 도구의 user_id를 코드에서 강제 주입
          if (block.name.startsWith(LINE_PUSH_PREFIX)) {
            toolInput.user_id = context.userId;
            log.debug("Injected userId for LINE push", { tool: block.name, userId: context.userId });
          }

          const result = await executor(toolInput);
          log.debug("Tool result", { tool: block.name, resultLength: result.length, isError: false });
          return {
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: result,
          };
        } catch (e) {
          log.debug("Tool result", { tool: block.name, error: toErrorMessage(e), isError: true });
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

  return {
    text: "Tool call limit reached. Processing has been stopped.",
    toolCalls,
  };
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

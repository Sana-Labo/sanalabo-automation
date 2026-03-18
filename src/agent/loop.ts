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
import { infraToolDefs, infraTools } from "./infra-tools.js";
import { buildSystemPrompt } from "./system.js";

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
  const workspace = deps.workspaceStore.get(context.workspaceId);
  const systemPrompt = buildSystemPrompt(context, workspace);

  // Build per-request executors: base registry + workspace-specific GWS executors
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
  const allTools = [...deps.registry.tools, ...infraToolDefs];

  while (turns < MAX_TURNS) {
    turns++;

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      tools: allTools,
      messages,
    });

    if (response.stop_reason === "max_tokens") {
      const text = extractText(response.content) || "応答が長すぎて切り詰められました。";
      await ensureDelivery(text);
      return { text, toolCalls };
    }

    if (response.stop_reason !== "tool_use") {
      const text = extractText(response.content);
      await ensureDelivery(text);
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
        const toolInput = block.input as Record<string, unknown>;

        // Write interception for non-owner members
        const interception = await interceptWrite(
          block.name,
          toolInput,
          context,
          deps.pendingActionStore,
          userMessage,
        );

        if (interception.intercepted) {
          // Notify owner asynchronously (W8: log failures instead of silent drop)
          notifyOwnerOfPending(
            interception.pendingAction,
            deps.registry,
            deps.workspaceStore,
          ).catch((e) => {
            console.error(`[approvals] Failed to notify owner of pending action ${interception.pendingAction.id}:`, toErrorMessage(e));
          });

          return {
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: "この操作はオーナーの承認が必要です。承認リクエストを送信しました。",
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
          // Belt-and-suspenders: enforce user_id for LINE push tools
          if (isLinePush) {
            toolInput.user_id = context.userId;
          }

          const result = await executor(toolInput);
          // Set only on success — if push fails, ensureDelivery fallback may retry
          if (isLinePush) {
            delivery = "pushed";
          }
          return {
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: result,
          };
        } catch (e) {
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

  const text = "ツール呼び出しの上限に達しました。処理を中断します。";
  await ensureDelivery(text);
  return { text, toolCalls };

  /** Send response via LINE if the agent did not push itself */
  async function ensureDelivery(text: string): Promise<void> {
    if (delivery !== "pending" || !text) return;
    const exec = executors.get(LINE_PUSH_TEXT_TOOL);
    if (!exec) {
      console.warn("[agent] push_text_message executor not found — response not delivered");
      return;
    }
    try {
      await exec({ user_id: context.userId, text });
      delivery = "pushed";
    } catch (e) {
      console.error("[agent] ensureDelivery failed:", toErrorMessage(e));
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

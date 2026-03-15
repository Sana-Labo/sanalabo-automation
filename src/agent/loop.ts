import Anthropic from "@anthropic-ai/sdk";
import type { AgentResult, ToolExecutor, ToolRegistry } from "../types.js";
import { buildSystemPrompt } from "./system.js";

const MAX_ITERATIONS = 15;
const MODEL = "claude-haiku-4-5-20251001";

export async function runAgentLoop(
  userMessage: string,
  registry: ToolRegistry,
): Promise<AgentResult> {
  const client = new Anthropic();

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  let toolCalls = 0;

  while (toolCalls < MAX_ITERATIONS) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: buildSystemPrompt(),
      tools: registry.tools,
      messages,
    });

    if (response.stop_reason === "end_turn" || response.stop_reason !== "tool_use") {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      return { text, toolCalls };
    }

    // Extract tool_use blocks
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    // Build tool results
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of toolUseBlocks) {
      toolCalls++;
      const executor = registry.executors.get(block.name);

      if (!executor) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Error: Unknown tool "${block.name}"`,
          is_error: true,
        });
        continue;
      }

      try {
        const result = await executor(block.input as Record<string, unknown>);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result,
        });
      } catch (e) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Error: ${e instanceof Error ? e.message : String(e)}`,
          is_error: true,
        });
      }
    }

    // Append assistant response and tool results to conversation
    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });
  }

  // Max iterations reached
  return {
    text: "ツール呼び出しの上限に達しました。処理を中断します。",
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

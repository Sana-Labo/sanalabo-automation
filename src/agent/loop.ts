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
import { buildSystemPrompt } from "./system.js";

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

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  let turns = 0;
  let toolCalls = 0;

  while (turns < MAX_TURNS) {
    turns++;

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      tools: deps.registry.tools,
      messages,
    });

    if (response.stop_reason === "max_tokens") {
      const text = extractText(response.content);
      return { text: text || "応答が長すぎて切り詰められました。", toolCalls };
    }

    if (response.stop_reason !== "tool_use") {
      return { text: extractText(response.content), toolCalls };
    }

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    const toolResults = await Promise.all(
      toolUseBlocks.map(async (block) => {
        toolCalls++;
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
          // 비동기로 오너에게 통지 (실패 시 로그 기록, silent drop 방지)
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
          // 이중 안전장치: LINE push 도구의 user_id를 코드에서 강제 주입
          if (block.name.startsWith(LINE_PUSH_PREFIX)) {
            toolInput.user_id = context.userId;
          }

          const result = await executor(toolInput);
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

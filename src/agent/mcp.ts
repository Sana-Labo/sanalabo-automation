import type Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { config } from "../config.js";
import { MCP_ALLOWED_TOOLS, type ToolExecutor } from "../types.js";
import { toErrorMessage } from "../utils/error.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("mcp");

export interface McpConnection {
  tools: Anthropic.Tool[];
  executors: Map<string, ToolExecutor>;
  close: () => Promise<void>;
  getStatus?: () => unknown;
}

const MCP_PACKAGE = "@line/line-bot-mcp-server";

interface McpRuntime {
  command: string;
  args: string[];
}

const RUNTIMES: McpRuntime[] = [
  { command: "bunx", args: [MCP_PACKAGE] },
  { command: "npx", args: ["-y", MCP_PACKAGE] },
];

export function buildMcpEnv(): Record<string, string> {
  return {
    CHANNEL_ACCESS_TOKEN: config.lineChannelAccessToken,
    DESTINATION_USER_ID: config.systemAdminIds[0] ?? "",
    PUPPETEER_SKIP_DOWNLOAD: "true",
    PATH: process.env["PATH"] ?? "",
    HOME: process.env["HOME"] ?? "",
  };
}

async function tryConnect(
  runtime: McpRuntime,
  env: Record<string, string>,
): Promise<Client> {
  const transport = new StdioClientTransport({
    command: runtime.command,
    args: runtime.args,
    env,
  });

  const client = new Client({
    name: "sanalabo-agent",
    version: "1.0.0",
  });

  await client.connect(transport);
  return client;
}

export async function connectWithFallback(env: Record<string, string>): Promise<Client> {
  let lastError: unknown;

  for (const runtime of RUNTIMES) {
    try {
      log.info("Trying runtime", { command: runtime.command, args: runtime.args.join(" ") });
      const client = await tryConnect(runtime, env);
      log.info("Connected", { command: runtime.command });
      return client;
    } catch (e) {
      lastError = e;
      log.warning("Runtime failed", { command: runtime.command, error: toErrorMessage(e) });
    }
  }

  throw new Error(
    `Failed to connect to LINE MCP Server: ${toErrorMessage(lastError)}`,
  );
}

export function extractMcpText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  if (!("content" in result) || !Array.isArray(result.content)) {
    return JSON.stringify(result);
  }

  const texts = result.content
    .filter((c: { type: string }): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text);

  if (result.isError) {
    throw new Error(texts.join("\n") || "MCP tool error");
  }

  return texts.join("\n");
}

export function mapMcpToAnthropicTools(
  mcpTools: Awaited<ReturnType<Client["listTools"]>>["tools"],
): Anthropic.Tool[] {
  return mcpTools.map((t) => {
    const { type: _type, ...rest } = t.inputSchema;
    return {
      name: t.name,
      description: t.description ?? "",
      input_schema: {
        type: "object" as const,
        ...rest,
      },
    };
  });
}

export async function connectMcp(): Promise<McpConnection> {
  const env = buildMcpEnv();

  // 가변 클라이언트 참조 — 재연결 시 교체
  let currentClient = await connectWithFallback(env);

  // 동시 재연결 시도를 단일 Promise로 병합
  let reconnecting: Promise<void> | null = null;

  async function reconnect(): Promise<void> {
    if (reconnecting) return reconnecting;

    reconnecting = (async () => {
      log.info("Reconnecting to LINE MCP Server...");
      try {
        await currentClient.close();
      } catch {
        // 기존 클라이언트가 이미 종료되었을 수 있음
      }
      currentClient = await connectWithFallback(env);
      log.info("Reconnected successfully");
    })();

    try {
      await reconnecting;
    } finally {
      reconnecting = null;
    }
  }

  // 도구 목록은 최초 1회만 탐색 + 화이트리스트 필터링
  const { tools: mcpTools } = await currentClient.listTools();
  const filteredTools = mcpTools.filter(t => MCP_ALLOWED_TOOLS.has(t.name));
  const tools = mapMcpToAnthropicTools(filteredTools);

  // 자동 재연결 executor 구성: 1회 시도 → 실패 시 재연결 → 1회 재시도
  const executors = new Map<string, ToolExecutor>();

  for (const t of filteredTools) {
    executors.set(t.name, async (input) => {
      const attempt = () =>
        currentClient
          .callTool({ name: t.name, arguments: input })
          .then(extractMcpText);

      try {
        return await attempt();
      } catch (e) {
        log.warning("Tool failed, reconnecting", { tool: t.name, error: toErrorMessage(e) });
        await reconnect();
        return await attempt();
      }
    });
  }

  return {
    tools,
    executors,
    close: async () => {
      await currentClient.close();
    },
  };
}

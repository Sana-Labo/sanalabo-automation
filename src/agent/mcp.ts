import type Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { config } from "../config.js";
import type { ToolExecutor } from "../types.js";
import { toErrorMessage } from "../utils/error.js";

export interface McpConnection {
  tools: Anthropic.Tool[];
  executors: Map<string, ToolExecutor>;
  close: () => Promise<void>;
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
      console.log(`[mcp] Trying ${runtime.command} ${runtime.args.join(" ")}...`);
      const client = await tryConnect(runtime, env);
      console.log(`[mcp] Connected via ${runtime.command}`);
      return client;
    } catch (e) {
      lastError = e;
      console.warn(
        `[mcp] ${runtime.command} failed:`,
        toErrorMessage(e),
      );
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

export async function connectMcp(): Promise<McpConnection> {
  const env = buildMcpEnv();

  // Mutable client reference — replaced on reconnect
  let currentClient = await connectWithFallback(env);

  // Coalesce concurrent reconnection attempts into a single promise
  let reconnecting: Promise<void> | null = null;

  async function reconnect(): Promise<void> {
    if (reconnecting) return reconnecting;

    reconnecting = (async () => {
      console.log("[mcp] Reconnecting to LINE MCP Server...");
      try {
        await currentClient.close();
      } catch {
        // Old client may already be dead
      }
      currentClient = await connectWithFallback(env);
      console.log("[mcp] Reconnected successfully");
    })();

    try {
      await reconnecting;
    } finally {
      reconnecting = null;
    }
  }

  // Discover tools once — LINE MCP Server's tool list is stable
  const { tools: mcpTools } = await currentClient.listTools();

  const tools: Anthropic.Tool[] = mcpTools.map((t) => {
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

  // Build executors with auto-reconnect: try once, reconnect on failure, retry once
  const executors = new Map<string, ToolExecutor>();

  for (const t of mcpTools) {
    executors.set(t.name, async (input) => {
      const attempt = () =>
        currentClient
          .callTool({ name: t.name, arguments: input })
          .then(extractMcpText);

      try {
        return await attempt();
      } catch (e) {
        console.warn(
          `[mcp] Tool "${t.name}" failed, reconnecting:`,
          toErrorMessage(e),
        );
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

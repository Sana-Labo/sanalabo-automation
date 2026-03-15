import type Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { config } from "../config.js";
import type { ToolExecutor } from "../types.js";

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

function buildMcpEnv(): Record<string, string> {
  return {
    CHANNEL_ACCESS_TOKEN: config.lineChannelAccessToken,
    DESTINATION_USER_ID: config.lineUserId,
    PATH: process.env["PATH"] ?? "",
    HOME: process.env["HOME"] ?? "",
  };
}

async function tryConnect(
  runtime: McpRuntime,
  env: Record<string, string>,
): Promise<{ client: Client; close: () => Promise<void> }> {
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

  return {
    client,
    close: () => client.close(),
  };
}

export async function connectMcp(): Promise<McpConnection> {
  const env = buildMcpEnv();
  let client: Client;
  let close: () => Promise<void>;

  let lastError: unknown;
  for (const runtime of RUNTIMES) {
    try {
      console.log(`[mcp] Trying ${runtime.command} ${runtime.args.join(" ")}...`);
      ({ client, close } = await tryConnect(runtime, env));
      console.log(`[mcp] Connected via ${runtime.command}`);
      break;
    } catch (e) {
      lastError = e;
      console.warn(
        `[mcp] ${runtime.command} failed:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  if (!client!) {
    throw new Error(
      `Failed to connect to LINE MCP Server with any runtime: ${lastError instanceof Error ? lastError.message : lastError}`,
    );
  }

  const { tools: mcpTools } = await client.listTools();

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

  const executors = new Map<string, ToolExecutor>();

  for (const t of mcpTools) {
    executors.set(t.name, async (input) => {
      const result = await client.callTool({
        name: t.name,
        arguments: input,
      });

      // callTool returns a union: { content, isError } | { toolResult }
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
    });
  }

  return { tools, executors, close: close! };
}

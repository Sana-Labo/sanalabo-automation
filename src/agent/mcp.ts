import type Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { config } from "../config.js";
import { CHANNEL_SKILL_TOOL_NAMES, type ToolExecutor } from "../types.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("mcp");

export interface McpConnection {
  tools: Anthropic.Tool[];
  executors: Map<string, ToolExecutor>;
  close: () => Promise<void>;
  getStatus?: () => unknown;
}

/** LINE MCP Server 엔트리 포인트 (로컬 의존성, 절대 경로로 CWD 비의존) */
const MCP_ENTRY = new URL(
  "../../node_modules/@line/line-bot-mcp-server/dist/index.js",
  import.meta.url,
).pathname;

export function buildMcpEnv(): Record<string, string> {
  const env: Record<string, string> = {
    CHANNEL_ACCESS_TOKEN: config.lineChannelAccessToken,
    DESTINATION_USER_ID: config.systemAdminIds[0] ?? "",
    PATH: process.env["PATH"] ?? "",
    HOME: process.env["HOME"] ?? "",
  };

  // Docker: 시스템 chromium 사용, 로컬: Puppeteer 기본값
  const execPath = process.env["PUPPETEER_EXECUTABLE_PATH"];
  if (execPath) {
    env["PUPPETEER_EXECUTABLE_PATH"] = execPath;
    env["PUPPETEER_SKIP_DOWNLOAD"] = "true";
  }

  return env;
}

/**
 * LINE MCP Server에 연결하는 MCP 클라이언트 생성
 *
 * 로컬 의존성에서 직접 node로 기동. npx/bunx 폴백 불필요 —
 * node_modules에 확정적으로 존재하며, 실패는 패키지 자체의 문제.
 */
export async function connectMcpClient(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [MCP_ENTRY],
    env,
  });

  const client = new Client({
    name: "sanalabo-agent",
    version: "1.0.0",
  });

  log.info("Connecting to LINE MCP Server", { entry: MCP_ENTRY });
  await client.connect(transport);
  log.info("Connected to LINE MCP Server");
  return client;
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

/**
 * MCP 도구를 Anthropic Tool 형식으로 변환
 *
 * 현재 MCP Pool의 도구 스키마는 Claude에 직접 전달되지 않음 —
 * `app.ts`에서 `LINE_CHANNEL_SKILL_TOOLS`(어댑터 간소화 스키마)를 사용.
 * 이 함수의 출력은 executor Map 구성 시 도구 필터링에만 사용됨.
 */
export function mapMcpToAnthropicTools(
  mcpTools: Awaited<ReturnType<Client["listTools"]>>["tools"],
): Anthropic.Tool[] {
  return mcpTools.map((t) => {
    const { type: _type, ...rest } = t.inputSchema;
    return {
      name: t.name,
      strict: true,
      description: t.description ?? "",
      input_schema: {
        type: "object" as const,
        ...rest,
        additionalProperties: false,
      },
    };
  });
}

/** MCP Server 도구 목록에서 화이트리스트 필터링 + Anthropic 형식 변환 */
export type McpToolList = Awaited<ReturnType<Client["listTools"]>>["tools"];
export function filterAndMapTools(mcpTools: McpToolList): {
  filtered: McpToolList;
  tools: Anthropic.Tool[];
} {
  const filtered = mcpTools.filter(t => CHANNEL_SKILL_TOOL_NAMES.has(t.name));
  return { filtered, tools: mapMcpToAnthropicTools(filtered) };
}

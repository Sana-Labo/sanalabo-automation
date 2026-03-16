import type Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ToolExecutor } from "../types.js";
import { toErrorMessage } from "../utils/error.js";
import { buildMcpEnv, connectWithFallback, extractMcpText } from "./mcp.js";
import type { McpConnection } from "./mcp.js";

export interface McpPoolConfig {
  size: number;
  healthCheckIntervalMs: number;
  callTimeoutMs: number;
  maxRetries: number;
}

const DEFAULT_CONFIG: McpPoolConfig = {
  size: 3,
  healthCheckIntervalMs: 30_000,
  callTimeoutMs: 30_000,
  maxRetries: 2,
};

type MemberState = "healthy" | "unhealthy" | "reconnecting";

interface PoolMember {
  id: number;
  client: Client;
  state: MemberState;
  inflight: number;
  reconnecting: Promise<void> | null;
  consecutiveFailures: number;
}

export interface McpPoolStatus {
  members: Array<{
    id: number;
    state: MemberState;
    inflight: number;
  }>;
  totalInflight: number;
}

// Pool status is exposed via McpConnection.getStatus() — no module singleton

export async function connectMcpPool(
  overrides?: Partial<McpPoolConfig>,
): Promise<McpConnection> {
  const cfg = { ...DEFAULT_CONFIG, ...overrides };
  const env = buildMcpEnv();

  // 1. Connect all pool members in parallel
  const members: PoolMember[] = await Promise.all(
    Array.from({ length: cfg.size }, async (_, i) => {
      console.log(`[mcp-pool] Connecting member ${i}...`);
      const client = await connectWithFallback(env);
      console.log(`[mcp-pool] Member ${i} connected`);
      return {
        id: i,
        client,
        state: "healthy" as MemberState,
        inflight: 0,
        reconnecting: null,
        consecutiveFailures: 0,
      };
    }),
  );

  // 2. Discover tools from the first member (all members serve the same tools)
  const { tools: mcpTools } = await members[0]!.client.listTools();

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

  // 3. Member selection: least-inflight among healthy members
  function selectMember(): PoolMember | undefined {
    let best: PoolMember | undefined;
    for (const m of members) {
      if (m.state !== "healthy") continue;
      if (!best || m.inflight < best.inflight) {
        best = m;
      }
    }
    return best;
  }

  // 4. Per-member isolated reconnection
  function reconnectMember(member: PoolMember): Promise<void> {
    if (member.reconnecting) return member.reconnecting;

    member.state = "reconnecting";
    member.reconnecting = (async () => {
      console.log(`[mcp-pool] Reconnecting member ${member.id}...`);
      try {
        await member.client.close();
      } catch {
        // Old client may already be dead
      }
      try {
        member.client = await connectWithFallback(env);
        member.state = "healthy";
        member.consecutiveFailures = 0;
        console.log(`[mcp-pool] Member ${member.id} reconnected`);
      } catch (e) {
        member.state = "unhealthy";
        console.error(`[mcp-pool] Member ${member.id} reconnect failed:`, toErrorMessage(e));
      }
    })();

    member.reconnecting.finally(() => {
      member.reconnecting = null;
    });

    return member.reconnecting;
  }

  // 5. Dispatch a tool call with retry across members
  async function dispatchCall(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
      const member = selectMember();

      if (!member) {
        // All unhealthy — wait briefly for any reconnection
        await new Promise((r) => setTimeout(r, 1000));
        const retryMember = selectMember();
        if (!retryMember) {
          throw new Error("All MCP pool members are unhealthy");
        }
        return await callOnMember(retryMember, toolName, input);
      }

      try {
        return await callOnMember(member, toolName, input);
      } catch (e) {
        lastError = e;
        member.consecutiveFailures++;
        if (member.consecutiveFailures >= 2) {
          member.state = "unhealthy";
          void reconnectMember(member);
        }
        console.warn(
          `[mcp-pool] Member ${member.id} failed for "${toolName}" (attempt ${attempt + 1}):`,
          toErrorMessage(e),
        );
      }
    }

    throw new Error(
      `MCP pool exhausted retries for "${toolName}": ${toErrorMessage(lastError)}`,
    );
  }

  async function callOnMember(
    member: PoolMember,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    member.inflight++;
    let timer: ReturnType<typeof setTimeout>;
    try {
      const result = await Promise.race([
        member.client.callTool({ name: toolName, arguments: input }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`MCP call timeout (${cfg.callTimeoutMs}ms)`)),
            cfg.callTimeoutMs,
          );
        }),
      ]);
      member.consecutiveFailures = 0;
      return extractMcpText(result);
    } finally {
      clearTimeout(timer!);
      member.inflight--;
    }
  }

  // 6. Build executors using pool dispatch
  const executors = new Map<string, ToolExecutor>();
  for (const t of mcpTools) {
    executors.set(t.name, (input) => dispatchCall(t.name, input));
  }

  // 7. Health check interval
  const healthInterval = setInterval(async () => {
    for (const member of members) {
      if (member.state === "reconnecting") continue;
      try {
        await member.client.ping();
        if (member.state === "unhealthy") {
          member.state = "healthy";
          member.consecutiveFailures = 0;
          console.log(`[mcp-pool] Member ${member.id} recovered`);
        }
      } catch {
        member.consecutiveFailures++;
        if (member.consecutiveFailures >= 3) {
          member.state = "unhealthy";
          void reconnectMember(member);
        }
      }
    }
  }, cfg.healthCheckIntervalMs);

  // 8. Pool status accessor (returned via McpConnection.getStatus)
  function getStatus(): McpPoolStatus {
    return {
      members: members.map((m) => ({
        id: m.id,
        state: m.state,
        inflight: m.inflight,
      })),
      totalInflight: members.reduce((sum, m) => sum + m.inflight, 0),
    };
  }

  // 9. Close all members
  async function closePool(): Promise<void> {
    clearInterval(healthInterval);
    await Promise.allSettled(members.map((m) => m.client.close()));
    console.log("[mcp-pool] All members closed");
  }

  console.log(`[mcp-pool] Pool ready (${cfg.size} members, ${tools.length} tools)`);

  return { tools, executors, close: closePool, getStatus };
}

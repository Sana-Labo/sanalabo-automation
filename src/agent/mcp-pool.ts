import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ToolExecutor } from "../types.js";
import { toErrorMessage } from "../utils/error.js";
import { createLogger } from "../utils/logger.js";
import { buildMcpEnv, connectWithFallback, extractMcpText, mapMcpToAnthropicTools } from "./mcp.js";
import type { McpConnection } from "./mcp.js";

const log = createLogger("mcp-pool");

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

// 풀 상태는 McpConnection.getStatus()로 노출 — 모듈 싱글턴 불필요

export async function connectMcpPool(
  overrides?: Partial<McpPoolConfig>,
): Promise<McpConnection> {
  const cfg = { ...DEFAULT_CONFIG, ...overrides };
  const env = buildMcpEnv();

  // 1. 모든 풀 멤버를 병렬 연결
  const members: PoolMember[] = await Promise.all(
    Array.from({ length: cfg.size }, async (_, i) => {
      log.info("Connecting member", { memberId: i });
      const client = await connectWithFallback(env);
      log.info("Member connected", { memberId: i });
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

  // 2. 첫 번째 멤버에서 도구 목록 탐색 (모든 멤버가 동일 도구 제공)
  const { tools: mcpTools } = await members[0]!.client.listTools();
  const tools = mapMcpToAnthropicTools(mcpTools);

  // 3. 멤버 선택: healthy 멤버 중 inflight가 가장 적은 멤버
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

  // 4. 멤버별 격리 재연결
  function reconnectMember(member: PoolMember): Promise<void> {
    if (member.reconnecting) return member.reconnecting;

    member.state = "reconnecting";
    member.reconnecting = (async () => {
      log.info("Reconnecting member", { memberId: member.id });
      try {
        await member.client.close();
      } catch {
        // 기존 클라이언트가 이미 종료되었을 수 있음
      }
      try {
        member.client = await connectWithFallback(env);
        member.state = "healthy";
        member.consecutiveFailures = 0;
        log.info("Member reconnected", { memberId: member.id });
      } catch (e) {
        member.state = "unhealthy";
        log.error("Member reconnect failed", { memberId: member.id, error: toErrorMessage(e) });
      }
    })();

    member.reconnecting.finally(() => {
      member.reconnecting = null;
    });

    return member.reconnecting;
  }

  // 5. 멤버 간 재시도를 포함한 도구 호출 디스패치
  async function dispatchCall(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
      const member = selectMember();

      if (!member) {
        // 전원 unhealthy — 재연결 대기 후 재시도
        await new Promise((r) => setTimeout(r, 1000));
        const retryMember = selectMember();
        if (!retryMember) {
          throw new Error("All MCP pool members are unhealthy");
        }
        return await callOnMember(retryMember, toolName, input);
      }

      try {
        log.debug("Dispatching tool call", { tool: toolName, memberId: member.id, inflight: member.inflight });
        const start = Date.now();
        const result = await callOnMember(member, toolName, input);
        log.debug("Tool call completed on member", { tool: toolName, memberId: member.id, durationMs: Date.now() - start });
        return result;
      } catch (e) {
        lastError = e;
        member.consecutiveFailures++;
        if (member.consecutiveFailures >= 2) {
          member.state = "unhealthy";
          void reconnectMember(member);
        }
        log.warning("Member failed for tool call", {
          memberId: member.id, tool: toolName, attempt: attempt + 1, error: toErrorMessage(e),
        });
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

  // 6. 풀 디스패치를 사용하여 executor 구성
  const executors = new Map<string, ToolExecutor>();
  for (const t of mcpTools) {
    executors.set(t.name, (input) => dispatchCall(t.name, input));
  }

  // 7. 헬스 체크 인터벌 (멤버 간 병렬 실행)
  const healthInterval = setInterval(async () => {
    await Promise.allSettled(
      members.map(async (member) => {
        if (member.state === "reconnecting") return;
        try {
          await member.client.ping();
          if (member.state === "unhealthy") {
            member.state = "healthy";
            member.consecutiveFailures = 0;
            log.info("Member recovered", { memberId: member.id });
          }
        } catch {
          member.consecutiveFailures++;
          if (member.consecutiveFailures >= 3) {
            member.state = "unhealthy";
            void reconnectMember(member);
          }
        }
      }),
    );
  }, cfg.healthCheckIntervalMs);

  // 8. 풀 상태 접근자 (McpConnection.getStatus로 반환)
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

  // 9. 전체 멤버 종료
  async function closePool(): Promise<void> {
    clearInterval(healthInterval);
    await Promise.allSettled(members.map((m) => m.client.close()));
    log.info("All members closed");
  }

  log.info("Pool ready", { poolSize: cfg.size, toolCount: tools.length });

  return { tools, executors, close: closePool, getStatus };
}

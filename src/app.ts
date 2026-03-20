import { Hono } from "hono";
import { LINE_CHANNEL_SKILL_TOOLS } from "./agent/line-tool-adapter.js";
import { buildToolRegistry } from "./agent/loop.js";
import { connectMcpPool } from "./agent/mcp-pool.js";
import { createPendingActionStore } from "./approvals/store.js";
import { config } from "./config.js";
import { createHealthRoute } from "./routes/health.js";
import { createLineWebhookRoute } from "./routes/lineWebhook.js";
import { startScheduler } from "./scheduler.js";
import { gwsTools } from "./skills/gws/tools.js";
import type { AgentDependencies, ToolRegistry } from "./types.js";
import { createUserStore } from "./users/store.js";
import { toErrorMessage } from "./utils/error.js";
import { configureLogging, createLogger } from "./utils/logger.js";
import { migrateFromFlatModel } from "./workspaces/migrate.js";
import { createWorkspaceStore } from "./workspaces/store.js";

const log = createLogger("app");

let mcpClose: (() => Promise<void>) | undefined;
let cronJobs: { stop: () => void }[] = [];

async function main() {
  // 0. 로깅 초기화 (다른 초기화보다 먼저)
  await configureLogging();

  // 1. 환경변수 검증
  const port = config.port;
  log.info("Environment validated");

  // 2. 저장소 초기화
  const userStore = await createUserStore();
  log.info("User store initialized");

  const workspaceStore = await createWorkspaceStore();
  log.info("Workspace store initialized");

  // 워크스페이스 미존재 시 flat 모델에서 자동 마이그레이션
  await migrateFromFlatModel(userStore, workspaceStore, config.systemAdminIds);

  const pendingActionStore = await createPendingActionStore();
  log.info("Pending action store initialized");

  // 3. MCP 풀 연결 (LINE MCP Server)
  log.info("Connecting MCP pool...");
  const mcp = await connectMcpPool({ size: config.mcpPoolSize });
  mcpClose = mcp.close;
  log.info("MCP pool connected", { toolCount: mcp.tools.length, poolSize: config.mcpPoolSize });

  // 4. 기본 도구 레지스트리 구성
  // GWS 도구 *정의*는 공통 — executor는 런타임에 워크스페이스별로 해결
  // LINE 도구: LLM에는 단순화 스키마 노출, executor는 MCP 원본 유지
  //   → loop.ts에서 createLineExecutors()로 래핑하여 입력 변환
  const registry: ToolRegistry = buildToolRegistry(
    { tools: gwsTools, executors: new Map() },
    { tools: LINE_CHANNEL_SKILL_TOOLS, executors: mcp.executors },
  );
  log.info("Tool registry built", { toolCount: registry.tools.length });

  // 5. 에이전트 의존성 (webhook + scheduler 공유)
  const deps: AgentDependencies = {
    registry,
    pendingActionStore,
    workspaceStore,
    userStore,
  };

  // 6. Hono 앱 생성
  const app = new Hono();
  app.route("/", createHealthRoute(mcp));
  app.route("/", createLineWebhookRoute(deps, userStore));

  // 7. 스케줄러 시작
  cronJobs = startScheduler(deps, userStore);

  log.info("Server starting", { port });

  // 8. Bun serve용 export
  return { port, fetch: app.fetch };
}

// 정상 종료 처리
process.on("SIGTERM", async () => {
  log.info("SIGTERM received, shutting down...");
  for (const job of cronJobs) {
    job.stop();
  }
  if (mcpClose) {
    await mcpClose();
  }
  process.exit(0);
});

export default await main().catch((err) => {
  log.error("Fatal startup error", { error: toErrorMessage(err) });
  process.exit(1);
});

import { Hono } from "hono";
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
import { migrateFromFlatModel } from "./workspaces/migrate.js";
import { createWorkspaceStore } from "./workspaces/store.js";

let mcpClose: (() => Promise<void>) | undefined;
let cronJobs: { stop: () => void }[] = [];

async function main() {
  // 1. 환경변수 검증
  const port = config.port;
  console.log("[app] Environment validated");

  // 2. 저장소 초기화
  const userStore = await createUserStore();
  console.log("[app] User store initialized");

  const workspaceStore = await createWorkspaceStore();
  console.log("[app] Workspace store initialized");

  // 워크스페이스 미존재 시 flat 모델에서 자동 마이그레이션
  await migrateFromFlatModel(userStore, workspaceStore, config.systemAdminIds);

  const pendingActionStore = await createPendingActionStore();
  console.log("[app] Pending action store initialized");

  // 3. MCP 풀 연결 (LINE MCP Server)
  console.log("[app] Connecting MCP pool...");
  const mcp = await connectMcpPool({ size: config.mcpPoolSize });
  mcpClose = mcp.close;
  console.log(`[app] MCP pool connected (${mcp.tools.length} tools, ${config.mcpPoolSize} members)`);

  // 4. 기본 도구 레지스트리 구성
  // GWS 도구 *정의*는 공통 — executor는 런타임에 워크스페이스별로 해결
  const registry: ToolRegistry = buildToolRegistry(
    { tools: gwsTools, executors: new Map() },
    { tools: mcp.tools, executors: mcp.executors },
  );
  console.log(`[app] Tool registry built (${registry.tools.length} tools total)`);

  // 5. 에이전트 의존성 (webhook + scheduler 공유)
  const deps: AgentDependencies = {
    registry,
    pendingActionStore,
    workspaceStore,
  };

  // 6. Hono 앱 생성
  const app = new Hono();
  app.route("/", createHealthRoute(mcp));
  app.route("/", createLineWebhookRoute(deps, userStore));

  // 7. 스케줄러 시작
  cronJobs = startScheduler(deps, userStore);

  console.log(`[app] Server starting on port ${port}`);

  // 8. Bun serve용 export
  return { port, fetch: app.fetch };
}

// 정상 종료 처리
process.on("SIGTERM", async () => {
  console.log("[app] SIGTERM received, shutting down...");
  for (const job of cronJobs) {
    job.stop();
  }
  if (mcpClose) {
    await mcpClose();
  }
  process.exit(0);
});

export default await main().catch((err) => {
  console.error("[app] Fatal startup error:", err);
  process.exit(1);
});

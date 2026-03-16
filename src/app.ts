import { Hono } from "hono";
import { buildToolRegistry } from "./agent/loop.js";
import { connectMcpPool } from "./agent/mcp-pool.js";
import { createPendingActionStore } from "./approvals/store.js";
import { config } from "./config.js";
import { health } from "./routes/health.js";
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
  // 1. Validate environment
  const port = config.port;
  console.log("[app] Environment validated");

  // 2. Initialize stores
  const userStore = await createUserStore();
  console.log("[app] User store initialized");

  const workspaceStore = await createWorkspaceStore();
  console.log("[app] Workspace store initialized");

  // Auto-migrate from flat user model if no workspaces exist
  await migrateFromFlatModel(userStore, workspaceStore, config.systemAdminIds);

  const pendingActionStore = await createPendingActionStore();
  console.log("[app] Pending action store initialized");

  // 3. Connect MCP Pool (LINE MCP Server)
  console.log("[app] Connecting MCP pool...");
  const mcp = await connectMcpPool({ size: config.mcpPoolSize });
  mcpClose = mcp.close;
  console.log(`[app] MCP pool connected (${mcp.tools.length} tools, ${config.mcpPoolSize} members)`);

  // 4. Build base tool registry
  // GWS tool *definitions* are universal — executors are resolved per-workspace at runtime
  const registry: ToolRegistry = buildToolRegistry(
    { tools: gwsTools, executors: new Map() },
    { tools: mcp.tools, executors: mcp.executors },
  );
  console.log(`[app] Tool registry built (${registry.tools.length} tools total)`);

  // 5. Agent dependencies (shared across webhook + scheduler)
  const deps: AgentDependencies = {
    registry,
    pendingActionStore,
    workspaceStore,
  };

  // 6. Create Hono app
  const app = new Hono();
  app.route("/", health);
  app.route("/", createLineWebhookRoute(deps, userStore));

  // 7. Start scheduler
  cronJobs = startScheduler(deps, userStore);

  console.log(`[app] Server starting on port ${port}`);

  // 8. Export for Bun serve
  return { port, fetch: app.fetch };
}

// Graceful shutdown
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

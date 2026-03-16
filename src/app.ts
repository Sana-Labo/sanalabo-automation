import { Hono } from "hono";
import { buildToolRegistry } from "./agent/loop.js";
import { connectMcpPool } from "./agent/mcp-pool.js";
import { config } from "./config.js";
import { health } from "./routes/health.js";
import { createLineWebhookRoute } from "./routes/lineWebhook.js";
import { startScheduler } from "./scheduler.js";
import { createGwsExecutors } from "./skills/gws/executor.js";
import { gwsTools } from "./skills/gws/tools.js";
import type { ToolRegistry } from "./types.js";
import { createUserStore } from "./users/store.js";

let mcpClose: (() => Promise<void>) | undefined;
let cronJobs: { stop: () => void }[] = [];

async function main() {
  // 1. Validate environment
  const port = config.port;
  console.log("[app] Environment validated");

  // 2. Initialize user store
  const userStore = await createUserStore();
  console.log("[app] User store initialized");

  // 3. Connect MCP Pool (LINE MCP Server)
  console.log("[app] Connecting MCP pool...");
  const mcp = await connectMcpPool({ size: config.mcpPoolSize });
  mcpClose = mcp.close;
  console.log(`[app] MCP pool connected (${mcp.tools.length} tools, ${config.mcpPoolSize} members)`);

  // 4. Build tool registry (Native + MCP)
  const gwsExecutors = createGwsExecutors();
  const registry: ToolRegistry = buildToolRegistry(
    { tools: gwsTools, executors: gwsExecutors },
    { tools: mcp.tools, executors: mcp.executors },
  );
  console.log(`[app] Tool registry built (${registry.tools.length} tools total)`);

  // 5. Create Hono app
  const app = new Hono();
  app.route("/", health);
  app.route("/", createLineWebhookRoute(registry, userStore));

  // 6. Start scheduler
  cronJobs = startScheduler(registry, userStore);

  console.log(`[app] Server starting on port ${port}`);

  // 7. Export for Bun serve
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

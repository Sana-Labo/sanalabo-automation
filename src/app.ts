import { Hono } from "hono";
import { buildToolRegistry } from "./agent/loop.js";
import { connectMcp } from "./agent/mcp.js";
import { config } from "./config.js";
import { health } from "./routes/health.js";
import { createLineWebhookRoute } from "./routes/lineWebhook.js";
import { startScheduler } from "./scheduler.js";
import { createGwsExecutors } from "./skills/gws/executor.js";
import { gwsTools } from "./skills/gws/tools.js";
import type { ToolRegistry } from "./types.js";

let mcpClose: (() => Promise<void>) | undefined;
let cronJobs: { stop: () => void }[] = [];

async function main() {
  // 1. Validate environment
  const port = config.port;
  console.log("[app] Environment validated");

  // 2. Connect MCP (LINE MCP Server)
  console.log("[app] Connecting to LINE MCP Server...");
  const mcp = await connectMcp();
  mcpClose = mcp.close;
  console.log(`[app] LINE MCP Server connected (${mcp.tools.length} tools)`);

  // 3. Build tool registry (Native + MCP)
  const gwsExecutors = createGwsExecutors();
  const registry: ToolRegistry = buildToolRegistry(
    { tools: gwsTools, executors: gwsExecutors },
    { tools: mcp.tools, executors: mcp.executors },
  );
  console.log(`[app] Tool registry built (${registry.tools.length} tools total)`);

  // 4. Create Hono app
  const app = new Hono();
  app.route("/", health);
  app.route("/", createLineWebhookRoute(registry));

  // 5. Start scheduler
  cronJobs = startScheduler(registry);

  console.log(`[app] Server starting on port ${port}`);

  // 6. Export for Bun serve
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

export default await main();

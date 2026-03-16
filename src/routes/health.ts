import { Hono } from "hono";
import { getPoolStatus } from "../agent/mcp-pool.js";

const health = new Hono();

health.get("/health", (c) => {
  const pool = getPoolStatus();
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    mcpPool: pool ?? "not initialized",
  });
});

export { health };

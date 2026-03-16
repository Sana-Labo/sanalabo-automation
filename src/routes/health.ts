import { Hono } from "hono";
import type { McpConnection } from "../agent/mcp.js";

export function createHealthRoute(mcp: McpConnection) {
  const route = new Hono();

  route.get("/health", (c) => {
    const pool = mcp.getStatus ? mcp.getStatus() : "not available";
    return c.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      mcpPool: pool,
    });
  });

  return route;
}

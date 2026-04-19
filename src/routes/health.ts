import { Hono } from "hono";
import type { McpConnection } from "../agent/mcp.js";

export function createHealthRoute(mcp: McpConnection) {
  const route = new Hono();

  route.get("/health", (c) => {
    const pool = mcp.getStatus ? mcp.getStatus() : "not available";
    // Phase 4 PR 4-c V4 smoke test — healthcheck 실패를 유도해 deploy-dev
    // workflow의 rollback step 동작을 관찰하기 위한 의도적 500 응답. 관찰
    // 완료 후 즉시 revert PR로 원복한다.
    return c.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      mcpPool: pool,
    }, 500);
  });

  return route;
}

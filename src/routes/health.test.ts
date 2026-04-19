import { describe, test, expect } from "bun:test";
import { createHealthRoute } from "./health.js";
import type { McpConnection } from "../agent/mcp.js";

describe("GET /health", () => {
  test("returns status 200 with status ok", async () => {
    const mcp = { getStatus: () => ({ healthy: true, members: 3 }) } as McpConnection;
    const route = createHealthRoute(mcp);

    const res = await route.request("/health");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
  });

  test("includes mcpPool from getStatus when available", async () => {
    const poolInfo = { size: 3, healthy: 2, unhealthy: 1 };
    const mcp = { getStatus: () => poolInfo } as McpConnection;
    const route = createHealthRoute(mcp);

    const res = await route.request("/health");
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.mcpPool).toEqual(poolInfo);
  });

  test("mcpPool is 'not available' when getStatus is undefined", async () => {
    const mcp = {} as McpConnection;
    const route = createHealthRoute(mcp);

    const res = await route.request("/health");
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.mcpPool).toBe("not available");
  });
});

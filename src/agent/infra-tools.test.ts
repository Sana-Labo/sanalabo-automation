import { describe, test, expect } from "bun:test";
import { infraToolDefs, infraTools } from "./infra-tools.js";
import type { ToolContext } from "../types.js";

// --- 픽스처 ---

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    userId: "Uowner1234",
    workspaceId: "ws-001",
    role: "owner",
    ...overrides,
  };
}

// --- 테스트 ---

describe("infraTools registry", () => {
  test("infraTools contains no_action", () => {
    expect(infraTools.has("no_action")).toBe(true);
  });

  test("infraToolDefs includes no_action definition", () => {
    const names = infraToolDefs.map((d) => d.name);
    expect(names).toContain("no_action");
  });

  test("infraTools and infraToolDefs are consistent", () => {
    // Every def has a matching handler in the Map
    for (const def of infraToolDefs) {
      expect(infraTools.has(def.name)).toBe(true);
      expect(infraTools.get(def.name)!.def).toBe(def);
    }
    // Map size matches defs length
    expect(infraTools.size).toBe(infraToolDefs.length);
  });

  test("모든 인프라 도구에 strict: true + additionalProperties: false 설정", () => {
    for (const def of infraToolDefs) {
      expect(def.strict).toBe(true);
      expect(def.input_schema.additionalProperties).toBe(false);
    }
  });
});

describe("noAction handler", () => {
  test("returns exitLoop: true with empty exitText", () => {
    const entry = infraTools.get("no_action")!;
    const signal = entry.handler({ reason: "no new mail" }, makeContext());

    expect(signal.exitLoop).toBe(true);
    expect(signal.exitText).toBe("");
    expect(signal.toolResult).toBeString();
  });

  test("handles missing reason gracefully", () => {
    const entry = infraTools.get("no_action")!;
    const signal = entry.handler({}, makeContext());

    expect(signal.exitLoop).toBe(true);
  });

  test("receives context (future extensibility)", () => {
    const entry = infraTools.get("no_action")!;
    const ctx = makeContext({ role: "member", userId: "Umember5678" });
    // Should not throw when context is passed
    const signal = entry.handler({ reason: "test" }, ctx);
    expect(signal.exitLoop).toBe(true);
  });
});

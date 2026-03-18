import { describe, test, expect } from "bun:test";
import { infraToolDefs, infraTools } from "./infra-tools.js";
import type { ToolContext } from "../types.js";

// --- Fixtures ---

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    userId: "Uowner1234",
    workspaceId: "ws-001",
    role: "owner",
    ...overrides,
  };
}

// --- Tests ---

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
});

describe("noAction handler", () => {
  test("returns exitLoop: true with delivery no_action", () => {
    const entry = infraTools.get("no_action")!;
    const signal = entry.handler({ reason: "no new mail" }, makeContext());

    expect(signal.exitLoop).toBe(true);
    expect(signal.delivery).toBe("no_action");
    expect(signal.exitText).toBe("");
    expect(signal.toolResult).toBeString();
  });

  test("handles missing reason gracefully", () => {
    const entry = infraTools.get("no_action")!;
    const signal = entry.handler({}, makeContext());

    expect(signal.exitLoop).toBe(true);
    expect(signal.delivery).toBe("no_action");
  });

  test("receives context (future extensibility)", () => {
    const entry = infraTools.get("no_action")!;
    const ctx = makeContext({ role: "member", userId: "Umember5678" });
    // Should not throw when context is passed
    const signal = entry.handler({ reason: "test" }, ctx);
    expect(signal.exitLoop).toBe(true);
  });
});

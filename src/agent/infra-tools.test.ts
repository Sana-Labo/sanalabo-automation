import { describe, test, expect } from "bun:test";
import { infraToolDefs, infraTools, infraToolDefinitions } from "./infra-tools.js";
import { toAnthropicTool } from "./tool-definition.js";
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

// --- ToolDefinition (새 구조) 테스트 ---

describe("infraToolDefinitions (Zod)", () => {
  test("infraToolDefinitions에 no_action 포함", () => {
    const names = infraToolDefinitions.map((d) => d.name);
    expect(names).toContain("no_action");
  });

  test("Zod → JSON Schema 라운드트립: 레거시 infraToolDefs와 일치", () => {
    for (const def of infraToolDefinitions) {
      const anthropicTool = toAnthropicTool(def);
      const legacyDef = infraToolDefs.find((d) => d.name === def.name)!;

      expect(anthropicTool.name).toBe(legacyDef.name);
      expect(anthropicTool.description).toBe(legacyDef.description);
      expect(anthropicTool.strict).toBe(legacyDef.strict);
      expect(anthropicTool.input_schema.type).toBe("object");
      expect(anthropicTool.input_schema.additionalProperties).toBe(false);

      // properties 비교: reason 필드 존재
      const props = anthropicTool.input_schema.properties as Record<string, Record<string, unknown>>;
      expect(props.reason).toBeDefined();
      expect(props.reason!.type).toBe("string");

      // required 비교: reason 필수
      const required = anthropicTool.input_schema.required as string[];
      expect(required).toContain("reason");
    }
  });

  test("새 handler는 타입 안전 입력을 받음", () => {
    const def = infraToolDefinitions.find((d) => d.name === "no_action")!;
    const signal = def.handler({ reason: "test typed" }, makeContext());

    expect(signal.exitLoop).toBe(true);
    expect(signal.exitText).toBe("");
    expect(signal.toolResult).toBeString();
  });

  test("Zod 스키마 검증: 유효 입력", () => {
    const def = infraToolDefinitions.find((d) => d.name === "no_action")!;
    const result = def.inputSchema.safeParse({ reason: "valid" });
    expect(result.success).toBe(true);
  });

  test("Zod 스키마 검증: 무효 입력 (reason 누락)", () => {
    const def = infraToolDefinitions.find((d) => d.name === "no_action")!;
    const result = def.inputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("Zod 스키마 검증: 무효 입력 (reason 타입 오류)", () => {
    const def = infraToolDefinitions.find((d) => d.name === "no_action")!;
    const result = def.inputSchema.safeParse({ reason: 123 });
    expect(result.success).toBe(false);
  });
});

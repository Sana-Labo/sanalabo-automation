import { describe, test, expect } from "bun:test";
import { infraToolDefinitions } from "./infra-tools.js";
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

describe("infraToolDefinitions", () => {
  test("no_action 포함", () => {
    const names = infraToolDefinitions.map((d) => d.name);
    expect(names).toContain("no_action");
  });

  test("모든 정의에 strict: true 설정", () => {
    for (const def of infraToolDefinitions) {
      expect(def.strict).toBe(true);
    }
  });

  test("toAnthropicTool 변환: additionalProperties: false", () => {
    for (const def of infraToolDefinitions) {
      const tool = toAnthropicTool(def);
      expect(tool.strict).toBe(true);
      expect(tool.input_schema.additionalProperties).toBe(false);
    }
  });

  test("toAnthropicTool 변환: reason 필드 + required", () => {
    const def = infraToolDefinitions.find((d) => d.name === "no_action")!;
    const tool = toAnthropicTool(def);
    const props = tool.input_schema.properties as Record<string, Record<string, unknown>>;
    expect(props.reason).toBeDefined();
    expect(props.reason!.type).toBe("string");

    const required = tool.input_schema.required as string[];
    expect(required).toContain("reason");
  });
});

describe("noAction handler", () => {
  test("returns exitLoop: true with empty exitText", () => {
    const def = infraToolDefinitions.find((d) => d.name === "no_action")!;
    const signal = def.handler({ reason: "no new mail" } as any, makeContext());

    expect(signal.exitLoop).toBe(true);
    expect(signal.exitText).toBe("");
    expect(signal.toolResult).toBeString();
  });

  test("receives context (future extensibility)", () => {
    const def = infraToolDefinitions.find((d) => d.name === "no_action")!;
    const ctx = makeContext({ role: "member", userId: "Umember5678" });
    const signal = def.handler({ reason: "test" } as any, ctx);
    expect(signal.exitLoop).toBe(true);
  });
});

describe("Zod 스키마 검증", () => {
  test("유효 입력", () => {
    const def = infraToolDefinitions.find((d) => d.name === "no_action")!;
    const result = def.inputSchema.safeParse({ reason: "valid" });
    expect(result.success).toBe(true);
  });

  test("무효 입력 (reason 누락)", () => {
    const def = infraToolDefinitions.find((d) => d.name === "no_action")!;
    const result = def.inputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("무효 입력 (reason 타입 오류)", () => {
    const def = infraToolDefinitions.find((d) => d.name === "no_action")!;
    const result = def.inputSchema.safeParse({ reason: 123 });
    expect(result.success).toBe(false);
  });
});

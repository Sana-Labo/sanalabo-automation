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
  test("no_action: strict + additionalProperties: false + reason required", () => {
    const def = infraToolDefinitions.find((d) => d.name === "no_action")!;
    expect(def.strict).toBe(true);

    const tool = toAnthropicTool(def);
    expect(tool.strict).toBe(true);
    expect(tool.input_schema.additionalProperties).toBe(false);

    const props = tool.input_schema.properties as Record<string, Record<string, unknown>>;
    expect(props.reason!.type).toBe("string");
    expect(tool.input_schema.required).toContain("reason");
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

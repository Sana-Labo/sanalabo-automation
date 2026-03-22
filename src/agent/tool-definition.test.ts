import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { toAnthropicTool, formatZodError } from "./tool-definition.js";
import type { ToolDefinition } from "./tool-definition.js";

// --- 헬퍼 ---

/** ToolDefinition<T>의 공변 문제를 회피하기 위한 팩토리 */
function makeDef<T>(def: {
  name: string;
  description: string;
  inputSchema: z.ZodType<T>;
  strict?: boolean;
}): ToolDefinition {
  return def as ToolDefinition;
}

// --- toAnthropicTool 변환 테스트 ---

describe("toAnthropicTool", () => {
  test("단순 필수 문자열 스키마 변환", () => {
    const def = makeDef({
      name: "test_tool",
      description: "A test tool",
      inputSchema: z.object({
        name: z.string().describe("The name"),
      }),
    });

    const result = toAnthropicTool(def);

    expect(result.name).toBe("test_tool");
    expect(result.description).toBe("A test tool");
    expect(result.input_schema.type).toBe("object");
    expect(result.input_schema.additionalProperties).toBe(false);

    const props = result.input_schema.properties as Record<string, Record<string, unknown>>;
    expect(props.name!.type).toBe("string");
    expect(props.name!.description).toBe("The name");

    const required = result.input_schema.required as string[];
    expect(required).toContain("name");
  });

  test("선택 필드가 required에서 제외됨", () => {
    const def = makeDef({
      name: "optional_tool",
      description: "Tool with optional fields",
      inputSchema: z.object({
        query: z.string().describe("Search query").optional(),
        maxResults: z.number().describe("Max results").optional(),
      }),
    });

    const result = toAnthropicTool(def);
    const required = result.input_schema.required as string[] | undefined;

    // optional 필드만이면 required 없거나 빈 배열
    expect(!required || required.length === 0).toBe(true);
  });

  test("필수 + 선택 혼합 스키마", () => {
    const def = makeDef({
      name: "mixed_tool",
      description: "Mixed fields",
      inputSchema: z.object({
        id: z.string().describe("Required ID"),
        label: z.string().describe("Optional label").optional(),
      }),
    });

    const result = toAnthropicTool(def);
    const required = result.input_schema.required as string[];

    expect(required).toContain("id");
    expect(required).not.toContain("label");
  });

  test("enum 필드 (drive_share role 패턴)", () => {
    const def = makeDef({
      name: "enum_tool",
      description: "Tool with enum",
      inputSchema: z.object({
        role: z
          .enum(["reader", "commenter", "writer"])
          .describe("Permission role")
          .optional(),
      }),
    });

    const result = toAnthropicTool(def);
    const props = result.input_schema.properties as Record<string, Record<string, unknown>>;

    expect(props.role!.enum).toEqual(["reader", "commenter", "writer"]);
  });

  test("배열 필드", () => {
    const def = makeDef({
      name: "array_tool",
      description: "Tool with array",
      inputSchema: z.object({
        labels: z.array(z.string()).describe("Label list").optional(),
      }),
    });

    const result = toAnthropicTool(def);
    const props = result.input_schema.properties as Record<string, Record<string, unknown>>;

    expect(props.labels!.type).toBe("array");
  });

  test("nullable 필드 (system tool 패턴)", () => {
    const def = makeDef({
      name: "nullable_tool",
      description: "Tool with nullable",
      inputSchema: z.object({
        owner_id: z.string().nullable().describe("Owner ID or null"),
      }),
    });

    const result = toAnthropicTool(def);
    const props = result.input_schema.properties as Record<string, Record<string, unknown>>;

    // nullable → anyOf: [{type: "string"}, {type: "null"}]
    const ownerProp = props.owner_id!;
    const hasNullable =
      ownerProp.nullable === true ||
      (Array.isArray(ownerProp.anyOf) &&
        (ownerProp.anyOf as Array<Record<string, unknown>>).some(
          (s) => s.type === "null",
        )) ||
      (Array.isArray(ownerProp.type) &&
        (ownerProp.type as string[]).includes("null"));

    expect(hasNullable).toBe(true);
  });

  test("strict: true가 결과에 포함됨", () => {
    const def = makeDef({
      name: "strict_tool",
      description: "Strict tool",
      strict: true,
      inputSchema: z.object({
        reason: z.string(),
      }),
    });

    const result = toAnthropicTool(def);
    expect(result.strict).toBe(true);
  });

  test("strict 미설정 시 결과에 strict 필드 없음", () => {
    const def = makeDef({
      name: "nonstrict_tool",
      description: "Non-strict tool",
      inputSchema: z.object({
        query: z.string(),
      }),
    });

    const result = toAnthropicTool(def);
    expect("strict" in result).toBe(false);
  });

  test("빈 스키마 (list_workspaces 패턴)", () => {
    const def = makeDef({
      name: "empty_tool",
      description: "No parameters",
      inputSchema: z.object({}),
    });

    const result = toAnthropicTool(def);
    expect(result.input_schema.type).toBe("object");
    expect(result.input_schema.additionalProperties).toBe(false);
  });

  test("$schema 필드가 제거됨", () => {
    const def = makeDef({
      name: "no_schema_field",
      description: "Test",
      inputSchema: z.object({ x: z.string() }),
    });

    const result = toAnthropicTool(def);
    expect("$schema" in result.input_schema).toBe(false);
  });
});

// --- formatZodError 테스트 ---

describe("formatZodError", () => {
  test("단일 에러 포맷팅", () => {
    const schema = z.object({ name: z.string() });
    const result = schema.safeParse({ name: 123 });

    expect(result.success).toBe(false);
    if (!result.success) {
      const message = formatZodError(result.error);
      expect(message).toContain("name");
    }
  });

  test("다중 에러 세미콜론 구분", () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
    });
    const result = schema.safeParse({ name: 123, age: "not a number" });

    expect(result.success).toBe(false);
    if (!result.success) {
      const message = formatZodError(result.error);
      expect(message).toContain(";");
      expect(message).toContain("name");
      expect(message).toContain("age");
    }
  });

  test("누락 필드 에러", () => {
    const schema = z.object({ id: z.string() });
    const result = schema.safeParse({});

    expect(result.success).toBe(false);
    if (!result.success) {
      const message = formatZodError(result.error);
      expect(message).toContain("id");
    }
  });

  test("루트 레벨 에러", () => {
    const schema = z.string();
    const result = schema.safeParse(123);

    expect(result.success).toBe(false);
    if (!result.success) {
      const message = formatZodError(result.error);
      expect(message).toContain("(root)");
    }
  });
});

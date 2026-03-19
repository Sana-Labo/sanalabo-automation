import { describe, expect, test } from "bun:test";
import { LINE_SIMPLIFIED_TOOLS, createLineExecutors } from "./line-tool-adapter.js";
import { LINE_PUSH_TEXT_TOOL, LINE_PUSH_FLEX_TOOL } from "../types.js";

// --- 스키마 정의 검증 ---

describe("LINE_SIMPLIFIED_TOOLS", () => {
  test("push_text_message와 push_flex_message 2개 정의", () => {
    expect(LINE_SIMPLIFIED_TOOLS).toHaveLength(2);
    const names = LINE_SIMPLIFIED_TOOLS.map((t) => t.name);
    expect(names).toContain(LINE_PUSH_TEXT_TOOL);
    expect(names).toContain(LINE_PUSH_FLEX_TOOL);
  });

  test("모든 도구에 strict: true 설정", () => {
    for (const tool of LINE_SIMPLIFIED_TOOLS) {
      expect(tool.strict).toBe(true);
    }
  });

  test("모든 도구에 additionalProperties: false 설정", () => {
    for (const tool of LINE_SIMPLIFIED_TOOLS) {
      expect(tool.input_schema.additionalProperties).toBe(false);
    }
  });

  test("push_text_message 스키마는 text만 required", () => {
    const tool = LINE_SIMPLIFIED_TOOLS.find((t) => t.name === LINE_PUSH_TEXT_TOOL)!;
    expect(tool.input_schema.required).toEqual(["text"]);
    const props = tool.input_schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("text");
    // user_id는 LLM 스키마에 없음 (adapter가 주입)
    expect(props).not.toHaveProperty("user_id");
  });

  test("push_flex_message 스키마는 altText, contents만 required", () => {
    const tool = LINE_SIMPLIFIED_TOOLS.find((t) => t.name === LINE_PUSH_FLEX_TOOL)!;
    expect(tool.input_schema.required).toEqual(["altText", "contents"]);
    const props = tool.input_schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("altText");
    expect(props).toHaveProperty("contents");
    expect(props).not.toHaveProperty("user_id");
  });
});

// --- executor 래핑 검증 ---

describe("createLineExecutors", () => {
  function makeMockExecutors() {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const executors = new Map<string, (input: Record<string, unknown>) => Promise<string>>();

    executors.set(LINE_PUSH_TEXT_TOOL, async (input) => {
      calls.push({ name: LINE_PUSH_TEXT_TOOL, input });
      return "ok";
    });
    executors.set(LINE_PUSH_FLEX_TOOL, async (input) => {
      calls.push({ name: LINE_PUSH_FLEX_TOOL, input });
      return "ok";
    });

    return { executors, calls };
  }

  test("push_text_message: text → MCP 네이티브 스키마로 변환 + userId 주입", async () => {
    const { executors, calls } = makeMockExecutors();
    const wrapped = createLineExecutors(executors, "U_user_123");

    const exec = wrapped.get(LINE_PUSH_TEXT_TOOL)!;
    await exec({ text: "Hello" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toEqual({
      user_id: "U_user_123",
      messages: [{ type: "text", text: "Hello" }],
    });
  });

  test("push_flex_message: altText + contents → MCP 네이티브 스키마로 변환 + userId 주입", async () => {
    const { executors, calls } = makeMockExecutors();
    const wrapped = createLineExecutors(executors, "U_user_456");

    const exec = wrapped.get(LINE_PUSH_FLEX_TOOL)!;
    await exec({ altText: "Summary", contents: { type: "bubble", body: {} } });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toEqual({
      user_id: "U_user_456",
      messages: [{ type: "flex", altText: "Summary", contents: { type: "bubble", body: {} } }],
    });
  });

  test("원본 executor에 없는 도구는 래핑하지 않음", () => {
    const executors = new Map<string, (input: Record<string, unknown>) => Promise<string>>();
    executors.set(LINE_PUSH_TEXT_TOOL, async () => "ok");
    // push_flex_message가 없음

    const wrapped = createLineExecutors(executors, "U_user_789");

    expect(wrapped.has(LINE_PUSH_TEXT_TOOL)).toBe(true);
    expect(wrapped.has(LINE_PUSH_FLEX_TOOL)).toBe(false);
  });

  test("래핑된 executor는 원본의 에러를 그대로 전파", async () => {
    const executors = new Map<string, (input: Record<string, unknown>) => Promise<string>>();
    executors.set(LINE_PUSH_TEXT_TOOL, async () => {
      throw new Error("MCP pool exhausted");
    });

    const wrapped = createLineExecutors(executors, "U_user_000");
    const exec = wrapped.get(LINE_PUSH_TEXT_TOOL)!;

    await expect(exec({ text: "test" })).rejects.toThrow("MCP pool exhausted");
  });
});

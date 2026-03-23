import { describe, expect, test } from "bun:test";
import {
  lineToolDefinitions,
  createLineExecutors,
  createChannelTextSender,
} from "./line-tool-adapter.js";
import { toAnthropicTool } from "./tool-definition.js";
import { LINE_PUSH_TEXT_TOOL, LINE_PUSH_FLEX_TOOL } from "../types.js";

// --- 공통 픽스처 ---

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

// --- 스키마 정의 검증 ---

describe("lineToolDefinitions", () => {
  test("push_text_message와 push_flex_message 2개 정의", () => {
    expect(lineToolDefinitions).toHaveLength(2);
    const names = lineToolDefinitions.map((d) => d.name);
    expect(names).toContain(LINE_PUSH_TEXT_TOOL);
    expect(names).toContain(LINE_PUSH_FLEX_TOOL);
  });

  test("push_text_message는 non-strict (Zod 검증)", () => {
    const def = lineToolDefinitions.find((d) => d.name === LINE_PUSH_TEXT_TOOL)!;
    expect(def.strict).toBeUndefined();
    const tool = toAnthropicTool(def);
    expect(tool.input_schema.additionalProperties).toBe(false);
  });

  test("push_flex_message는 non-strict", () => {
    const def = lineToolDefinitions.find((d) => d.name === LINE_PUSH_FLEX_TOOL)!;
    expect(def.strict).toBeUndefined();
    const tool = toAnthropicTool(def);
    expect(tool.input_schema.additionalProperties).toBe(false);
  });

  test("push_text_message 스키마는 text만 required", () => {
    const def = lineToolDefinitions.find((d) => d.name === LINE_PUSH_TEXT_TOOL)!;
    const tool = toAnthropicTool(def);
    expect(tool.input_schema.required).toEqual(["text"]);
    const props = tool.input_schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("text");
    expect(props).not.toHaveProperty("user_id");
  });

  test("push_flex_message 스키마는 altText, contents가 required", () => {
    const def = lineToolDefinitions.find((d) => d.name === LINE_PUSH_FLEX_TOOL)!;
    const tool = toAnthropicTool(def);
    expect(tool.input_schema.required).toEqual(["altText", "contents"]);
    const props = tool.input_schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("altText");
    expect(props).toHaveProperty("contents");
    expect(props).not.toHaveProperty("user_id");
  });
});

// --- executor 래핑 검증 ---

describe("createLineExecutors", () => {
  test("push_text_message: text → MCP 네이티브 스키마로 변환 + userId 주입", async () => {
    const { executors, calls } = makeMockExecutors();
    const wrapped = createLineExecutors(executors, "U_user_123");

    const exec = wrapped.get(LINE_PUSH_TEXT_TOOL)!;
    await exec({ text: "Hello" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toEqual({
      userId: "U_user_123",
      message: { type: "text", text: "Hello" },
    });
  });

  test("push_flex_message: altText + contents → MCP 네이티브 스키마로 변환 + userId 주입", async () => {
    const { executors, calls } = makeMockExecutors();
    const wrapped = createLineExecutors(executors, "U_user_456");

    const exec = wrapped.get(LINE_PUSH_FLEX_TOOL)!;
    await exec({ altText: "Summary", contents: { type: "bubble", body: {} } });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toEqual({
      userId: "U_user_456",
      message: { type: "flex", altText: "Summary", contents: { type: "bubble", body: {} } },
    });
  });

  test("원본 executor에 없는 도구는 래핑하지 않음", () => {
    const executors = new Map<string, (input: Record<string, unknown>) => Promise<string>>();
    executors.set(LINE_PUSH_TEXT_TOOL, async () => "ok");

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

// --- 채널 outbound adapter 검증 ---

describe("createChannelTextSender", () => {
  test("MCP 네이티브 스키마로 변환 + userId 주입", async () => {
    const { executors, calls } = makeMockExecutors();
    const sendText = createChannelTextSender(executors, "U_channel_001");

    await sendText("Hello from channel");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe(LINE_PUSH_TEXT_TOOL);
    expect(calls[0]!.input).toEqual({
      userId: "U_channel_001",
      message: { type: "text", text: "Hello from channel" },
    });
  });

  test("빈 문자열은 전송하지 않음", async () => {
    const { executors, calls } = makeMockExecutors();
    const sendText = createChannelTextSender(executors, "U_channel_002");

    await sendText("");

    expect(calls).toHaveLength(0);
  });

  test("push_text_message executor 미존재 시 무시", async () => {
    const executors = new Map<string, (input: Record<string, unknown>) => Promise<string>>();
    const sendText = createChannelTextSender(executors, "U_channel_003");

    await sendText("test");
  });
});

import "../test-utils/setup-env.js";
import { describe, expect, test } from "bun:test";
import { MCP_ALLOWED_TOOLS } from "../types.js";
import { filterAndMapTools, mapMcpToAnthropicTools } from "./mcp.js";

describe("MCP_ALLOWED_TOOLS", () => {
  test("push_text_message과 push_flex_message만 포함", () => {
    expect([...MCP_ALLOWED_TOOLS].sort()).toEqual([
      "push_flex_message",
      "push_text_message",
    ]);
  });
});

/** listTools() 결과를 모방하는 헬퍼 */
function mockTool(name: string) {
  return {
    name,
    description: `${name} tool`,
    inputSchema: {
      type: "object" as const,
      properties: { msg: { type: "string" } },
    },
  };
}

describe("filterAndMapTools", () => {
  const allTools = [
    mockTool("push_text_message"),
    mockTool("push_flex_message"),
    mockTool("create_rich_menu"),
    mockTool("get_profile"),
    mockTool("get_message_quota"),
  ];

  test("화이트리스트 도구만 필터링", () => {
    const { filtered, tools } = filterAndMapTools(allTools);

    expect(filtered).toHaveLength(2);
    expect(filtered.map(t => t.name).sort()).toEqual([
      "push_flex_message",
      "push_text_message",
    ]);
    expect(tools).toHaveLength(2);
  });

  test("허용 도구가 없으면 빈 결과 반환", () => {
    const unknownTools = [mockTool("unknown_tool")];
    const { filtered, tools } = filterAndMapTools(unknownTools);

    expect(filtered).toHaveLength(0);
    expect(tools).toHaveLength(0);
  });

  test("Anthropic 형식으로 올바르게 변환", () => {
    const { tools } = filterAndMapTools(allTools);

    for (const tool of tools) {
      expect(tool).toHaveProperty("name");
      expect(tool).toHaveProperty("description");
      expect(tool).toHaveProperty("input_schema");
      expect(tool.input_schema.type).toBe("object");
    }
  });
});

describe("mapMcpToAnthropicTools", () => {
  test("inputSchema의 type 필드를 제거하고 input_schema.type을 추가", () => {
    const mcpTools = [mockTool("test_tool")];
    const result = mapMcpToAnthropicTools(mcpTools);

    expect(result[0]!.input_schema).toEqual({
      type: "object",
      properties: { msg: { type: "string" } },
      additionalProperties: false,
    });
  });

  test("strict: true가 일괄 적용", () => {
    const mcpTools = [mockTool("tool_a"), mockTool("tool_b")];
    const result = mapMcpToAnthropicTools(mcpTools);

    for (const tool of result) {
      expect(tool.strict).toBe(true);
    }
  });
});

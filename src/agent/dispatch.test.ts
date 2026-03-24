import { describe, test, expect, mock } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { AgentDependencies, PendingActionStore, ToolContext, ToolExecutor } from "../types.js";
import type { ToolDefinition } from "./tool-definition.js";
import {
  buildToolList,
  dispatchInfra,
  dispatchSystem,
  dispatchSkill,
  mergeGwsExecutors,
  type LoopState,
  type AgentLoopOptions,
} from "./dispatch.js";
import { infraTool, systemTool, gwsTool, toAnthropicTool } from "./tool-definition.js";
import { z } from "zod";
import { TranscriptRecorder } from "./transcript.js";

// --- 테스트 헬퍼 ---

function makeToolUseBlock(name: string, input: Record<string, unknown> = {}, id?: string): Anthropic.ToolUseBlock {
  return {
    type: "tool_use",
    id: id ?? `toolu_${name}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    input,
  } as Anthropic.ToolUseBlock;
}

function makeLoopState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    context: { userId: "U_test", workspaceId: "ws_001", role: "owner" },
    systemPrompt: "test prompt",
    executors: new Map(),
    allDefMap: new Map(),
    allTools: [],
    transcript: new TranscriptRecorder("$TMPDIR"),
    ...overrides,
  };
}

const noopPendingStore: PendingActionStore = {
  create: async (input) => ({
    ...input,
    id: "pa_test",
    status: "pending" as const,
    createdAt: new Date().toISOString(),
  }),
  get: () => undefined,
  getByWorkspace: () => [],
  approve: async () => { throw new Error("not implemented"); },
  reject: async () => { throw new Error("not implemented"); },
  expireOlderThan: async () => 0,
  purgeResolved: async () => 0,
};

function makeDeps(overrides: Partial<AgentDependencies> = {}): AgentDependencies {
  return {
    registry: { definitions: [], executors: new Map() },
    pendingActionStore: noopPendingStore,
    workspaceStore: {
      get: () => undefined,
      getAll: () => [],
      create: async () => ({} as any),
      update: async () => {},
      getByOwner: () => [],
      getByMember: () => [],
      getUserRole: () => undefined,
    } as any,
    userStore: {} as any,
    getGwsExecutors: async () => null,
    ...overrides,
  };
}

// --- buildToolList ---

describe("buildToolList", () => {
  const readDef = gwsTool({
    name: "gmail_list",
    description: "List emails",
    inputSchema: z.object({}),
    createExecutor: () => async () => "ok",
  });

  const infraDef = infraTool({
    name: "no_action",
    description: "No action",
    inputSchema: z.object({ reason: z.string() }),
    handler: () => ({ toolResult: "ok", exitLoop: true, exitText: "" }),
  });

  test("executor 있는 skill 도구만 포함", () => {
    const defMap = new Map<string, ToolDefinition<any>>();
    defMap.set("gmail_list", readDef);
    const executors = new Map<string, ToolExecutor>();

    // executor 없으면 제외
    const without = buildToolList(defMap, executors, {});
    expect(without).toHaveLength(0);

    // executor 있으면 포함
    executors.set("gmail_list", async () => "ok");
    const withExec = buildToolList(defMap, executors, {});
    expect(withExec).toHaveLength(1);
    expect(withExec[0]?.name).toBe("gmail_list");
  });

  test("infra/system 도구는 executor 없이도 포함", () => {
    const defMap = new Map<string, ToolDefinition<any>>();
    defMap.set("no_action", infraDef);
    const tools = buildToolList(defMap, new Map(), { allowNoAction: true });
    expect(tools).toHaveLength(1);
  });

  test("no_action은 allowNoAction=false이면 제외", () => {
    const defMap = new Map<string, ToolDefinition<any>>();
    defMap.set("no_action", infraDef);
    const tools = buildToolList(defMap, new Map(), {});
    expect(tools).toHaveLength(0);
  });
});

// --- mergeGwsExecutors ---

describe("mergeGwsExecutors", () => {
  test("GWS executor가 null이면 대상 맵 변경 없음", async () => {
    const target = new Map<string, ToolExecutor>();
    const deps = makeDeps({ getGwsExecutors: async () => null });
    await mergeGwsExecutors(target, deps, "ws_001");
    expect(target.size).toBe(0);
  });

  test("GWS executor가 있으면 대상 맵에 병합", async () => {
    const target = new Map<string, ToolExecutor>();
    const gwsExecs = new Map<string, ToolExecutor>([
      ["gmail_list", async () => "emails"],
      ["calendar_list", async () => "events"],
    ]);
    const deps = makeDeps({ getGwsExecutors: async () => gwsExecs });
    await mergeGwsExecutors(target, deps, "ws_001");
    expect(target.size).toBe(2);
    expect(target.has("gmail_list")).toBe(true);
    expect(target.has("calendar_list")).toBe(true);
  });
});

// --- dispatchInfra ---

describe("dispatchInfra", () => {
  const noActionDef = infraTool({
    name: "no_action",
    description: "No action",
    inputSchema: z.object({ reason: z.string() }),
    handler: (input) => ({
      toolResult: "no_action acknowledged",
      exitLoop: true,
      exitText: "",
    }),
  });

  test("exitLoop 시그널이 있으면 exitResult 반환", () => {
    const defMap = new Map<string, ToolDefinition<any>>([["no_action", noActionDef]]);
    const state = makeLoopState({ allDefMap: defMap });
    const blocks = [makeToolUseBlock("no_action", { reason: "nothing to report" })];

    const result = dispatchInfra(blocks, state);

    expect(result.exitResult).toBeDefined();
    expect(result.exitResult?.text).toBe("");
    expect(result.toolCallCount).toBe(1);
    expect(result.results).toHaveLength(1);
  });

  test("infra 아닌 도구는 건너뜀", () => {
    const state = makeLoopState(); // allDefMap 비어있음
    const blocks = [makeToolUseBlock("gmail_list", {})];

    const result = dispatchInfra(blocks, state);

    expect(result.results).toHaveLength(0);
    expect(result.toolCallCount).toBe(0);
    expect(result.exitResult).toBeUndefined();
  });
});

// --- dispatchSystem ---

describe("dispatchSystem", () => {
  test("enter_workspace 시 LoopState 변경", async () => {
    const enterDef = systemTool({
      name: "enter_workspace",
      description: "Enter workspace",
      inputSchema: z.object({ workspace_id: z.string().optional() }),
      handler: async () => ({
        toolResult: "Entered workspace ws_002",
        enteredWorkspaceId: "ws_002",
      }),
    });

    const defMap = new Map<string, ToolDefinition<any>>([["enter_workspace", enterDef]]);
    const state = makeLoopState({
      allDefMap: defMap,
      context: { userId: "U_test", role: "owner" },
    });

    const deps = makeDeps({
      workspaceStore: {
        get: (id: string) => id === "ws_002" ? { id: "ws_002", ownerId: "U_test", displayName: "Test WS" } as any : undefined,
        getUserRole: () => "owner" as const,
        getByMember: () => [],
      } as any,
      getGwsExecutors: async () => new Map<string, ToolExecutor>([["gmail_list", async () => "ok"]]),
    });

    const blocks = [makeToolUseBlock("enter_workspace", {})];
    const result = await dispatchSystem(blocks, state, deps, {});

    expect(result.results).toHaveLength(1);
    expect(result.toolCallCount).toBe(1);
    // LoopState가 변경되었는지 확인
    expect(state.context.workspaceId).toBe("ws_002");
    expect(state.executors.has("gmail_list")).toBe(true);
  });

  test("leave_workspace 시 GWS executor 제거 + context 클리어", async () => {
    const leaveDef = systemTool({
      name: "leave_workspace",
      description: "Leave workspace",
      inputSchema: z.object({}),
      handler: async () => ({
        toolResult: "Left workspace",
        leftWorkspace: true,
      }),
    });

    const defMap = new Map<string, ToolDefinition<any>>([["leave_workspace", leaveDef]]);
    const executors = new Map<string, ToolExecutor>([
      ["gmail_list", async () => "emails"],
      ["push_text_message", async () => "sent"],
    ]);
    const state = makeLoopState({
      allDefMap: defMap,
      executors,
      context: { userId: "U_test", workspaceId: "ws_001", role: "owner" },
    });

    const deps = makeDeps({
      workspaceStore: { getByMember: () => [] } as any,
    });

    const blocks = [makeToolUseBlock("leave_workspace", {})];
    await dispatchSystem(blocks, state, deps, {});

    // GWS executor 제거 확인 (gmail_list는 GWS 도구)
    expect(state.executors.has("gmail_list")).toBe(false);
    // LINE executor는 유지
    expect(state.executors.has("push_text_message")).toBe(true);
    // context에서 workspaceId 제거
    expect(state.context.workspaceId).toBeUndefined();
  });

  test("system 아닌 도구는 건너뜀", async () => {
    const state = makeLoopState();
    const deps = makeDeps();
    const blocks = [makeToolUseBlock("gmail_list", {})];

    const result = await dispatchSystem(blocks, state, deps, {});
    expect(result.results).toHaveLength(0);
  });
});

// --- dispatchSkill ---

describe("dispatchSkill", () => {
  test("executor 정상 실행", async () => {
    const executors = new Map<string, ToolExecutor>([
      ["gmail_list", async () => '{"messages": []}'],
    ]);
    const defMap = new Map<string, ToolDefinition<any>>([
      ["gmail_list", gwsTool({
        name: "gmail_list",
        description: "List",
        inputSchema: z.object({}),
        createExecutor: () => async () => "ok",
      })],
    ]);
    const state = makeLoopState({ executors, allDefMap: defMap });
    const deps = makeDeps();
    const blocks = [makeToolUseBlock("gmail_list", {})];

    const result = await dispatchSkill(blocks, state, deps, "test");

    expect(result.results).toHaveLength(1);
    expect(result.toolCallCount).toBe(1);
    const r0 = result.results[0] as { content: string; is_error?: boolean };
    expect(r0.content).toBe('{"messages": []}');
  });

  test("executor 없으면 에러 반환", async () => {
    const state = makeLoopState();
    const deps = makeDeps();
    const blocks = [makeToolUseBlock("unknown_tool", {})];

    const result = await dispatchSkill(blocks, state, deps, "test");

    expect(result.results).toHaveLength(1);
    const r0 = result.results[0] as { content: string; is_error?: boolean };
    expect(r0.is_error).toBe(true);
    expect(r0.content).toContain("Unknown tool");
  });

  test("executor 예외 시 에러 반환 (루프 중단 아님)", async () => {
    const executors = new Map<string, ToolExecutor>([
      ["gmail_list", async () => { throw new Error("API error"); }],
    ]);
    const defMap = new Map<string, ToolDefinition<any>>([
      ["gmail_list", gwsTool({
        name: "gmail_list",
        description: "List",
        inputSchema: z.object({}),
        createExecutor: () => async () => "ok",
      })],
    ]);
    const state = makeLoopState({ executors, allDefMap: defMap });
    const deps = makeDeps();
    const blocks = [makeToolUseBlock("gmail_list", {})];

    const result = await dispatchSkill(blocks, state, deps, "test");

    expect(result.results).toHaveLength(1);
    const r0 = result.results[0] as { content: string; is_error?: boolean };
    expect(r0.is_error).toBe(true);
    expect(r0.content).toContain("API error");
  });

  test("member write 도구 → intercepted", async () => {
    const executors = new Map<string, ToolExecutor>([
      ["gmail_send", async () => "sent"],
    ]);
    const state = makeLoopState({
      executors,
      context: { userId: "U_member", workspaceId: "ws_001", role: "member" },
    });
    const deps = makeDeps();
    const blocks = [makeToolUseBlock("gmail_send", { to: "a@b.com" })];

    const result = await dispatchSkill(blocks, state, deps, "Send email");

    expect(result.results).toHaveLength(1);
    const r0 = result.results[0] as { content: string; is_error?: boolean };
    expect(r0.content).toContain("owner's approval");
  });

  test("채널 도구 실행 시 channelDelivered = true", async () => {
    const executors = new Map<string, ToolExecutor>([
      ["push_text_message", async () => "sent"],
    ]);
    const defMap = new Map<string, ToolDefinition<any>>();
    const state = makeLoopState({ executors, allDefMap: defMap });
    const deps = makeDeps();
    const blocks = [makeToolUseBlock("push_text_message", { userId: "U_test", message: { type: "text", text: "hi" } })];

    const result = await dispatchSkill(blocks, state, deps, "test");

    expect(result.channelDelivered).toBe(true);
  });
});

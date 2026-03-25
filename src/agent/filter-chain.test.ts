import { describe, test, expect } from "bun:test";
import {
  executeFilterChain,
  createLoggingFilter,
  createZodValidationFilter,
  createExecutorFilter,
  type FilterContext,
  type ToolFilter,
} from "./filter-chain.js";
import { gwsTool } from "./tool-definition.js";
import { z } from "zod";
import type { ToolExecutor } from "../types.js";

// --- 테스트 헬퍼 ---

function makeFilterContext(overrides: Partial<FilterContext> = {}): FilterContext {
  return {
    toolName: "test_tool",
    toolUseId: "toolu_test_123",
    input: {},
    definition: undefined,
    context: { userId: "U_test", workspaceId: "ws_001", role: "owner" },
    userMessage: "test message",
    metadata: {},
    ...overrides,
  };
}

// --- executeFilterChain ---

describe("executeFilterChain", () => {
  test("필터를 등록 순서대로 실행", async () => {
    const order: string[] = [];
    const filterA: ToolFilter = async (_ctx, next) => {
      order.push("A-pre");
      await next();
      order.push("A-post");
    };
    const filterB: ToolFilter = async (_ctx, next) => {
      order.push("B-pre");
      await next();
      order.push("B-post");
    };

    const ctx = makeFilterContext();
    await executeFilterChain([filterA, filterB], ctx);

    expect(order).toEqual(["A-pre", "B-pre", "B-post", "A-post"]);
  });

  test("short-circuit — next() 미호출 시 이후 필터 스킵", async () => {
    const order: string[] = [];
    const blockingFilter: ToolFilter = async (ctx, _next) => {
      order.push("block");
      ctx.result = "blocked";
      // next() 미호출 → 이후 필터 실행 안 됨
    };
    const neverReached: ToolFilter = async (_ctx, next) => {
      order.push("should-not-run");
      await next();
    };

    const ctx = makeFilterContext();
    await executeFilterChain([blockingFilter, neverReached], ctx);

    expect(order).toEqual(["block"]);
    expect(ctx.result).toBe("blocked");
  });

  test("빈 필터 배열 — 정상 완료", async () => {
    const ctx = makeFilterContext();
    await executeFilterChain([], ctx);
    expect(ctx.result).toBeUndefined();
  });

  test("필터가 ctx.input을 변환하면 다음 필터에 반영", async () => {
    const transformFilter: ToolFilter = async (ctx, next) => {
      ctx.input = { ...ctx.input, injected: true };
      await next();
    };
    const checkFilter: ToolFilter = async (ctx, _next) => {
      ctx.result = ctx.input.injected === true ? "yes" : "no";
    };

    const ctx = makeFilterContext({ input: { original: "value" } });
    await executeFilterChain([transformFilter, checkFilter], ctx);

    expect(ctx.result).toBe("yes");
  });
});

// --- createLoggingFilter ---

describe("createLoggingFilter", () => {
  test("next()를 호출하여 체인 진행", async () => {
    const loggingFilter = createLoggingFilter();
    let nextCalled = false;

    const ctx = makeFilterContext();
    await loggingFilter(ctx, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });
});

// --- createZodValidationFilter ---

describe("createZodValidationFilter", () => {
  const validDef = gwsTool({
    name: "test_tool",
    description: "Test",
    inputSchema: z.object({ query: z.string() }),
    requiredScopes: [],
    createExecutor: () => async () => "ok",
  });

  test("유효한 입력 → next() 호출 + 파싱된 데이터로 교체", async () => {
    const zodFilter = createZodValidationFilter();
    let nextCalled = false;
    const ctx = makeFilterContext({
      definition: validDef,
      input: { query: "test", extraField: "ignored" },
    });

    await zodFilter(ctx, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    // strict가 아닌 도구의 경우 Zod parse로 입력이 정제됨
    expect(ctx.input).toEqual({ query: "test" });
  });

  test("무효한 입력 → short-circuit + 에러 결과", async () => {
    const zodFilter = createZodValidationFilter();
    let nextCalled = false;
    const ctx = makeFilterContext({
      definition: validDef,
      input: { query: 123 }, // string이 아닌 number
    });

    await zodFilter(ctx, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(false);
    expect(ctx.isError).toBe(true);
    expect(ctx.result).toContain("Input validation error");
  });

  test("definition 없으면 검증 스킵 → next() 호출", async () => {
    const zodFilter = createZodValidationFilter();
    let nextCalled = false;
    const ctx = makeFilterContext({ definition: undefined });

    await zodFilter(ctx, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });

  test("strict 도구도 Zod 검증 통과 (업계 best practice)", async () => {
    const strictDef = gwsTool({
      name: "strict_tool",
      description: "Strict test",
      inputSchema: z.object({ id: z.string() }),
      requiredScopes: [],
      createExecutor: () => async () => "ok",
    });
    // gwsTool은 strict를 설정하지 않으므로 수동으로 설정
    (strictDef as any).strict = true;

    const zodFilter = createZodValidationFilter();
    let nextCalled = false;
    const ctx = makeFilterContext({
      definition: strictDef,
      input: { id: "test-123" },
    });

    await zodFilter(ctx, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });

  test("validateInput 실패 → short-circuit", async () => {
    const defWithValidation = gwsTool({
      name: "validated_tool",
      description: "Validated",
      inputSchema: z.object({ amount: z.number() }),
      requiredScopes: [],
      createExecutor: () => async () => "ok",
      validateInput: (input) =>
        input.amount > 0
          ? { valid: true }
          : { valid: false, error: "Amount must be positive" },
    });

    const zodFilter = createZodValidationFilter();
    let nextCalled = false;
    const ctx = makeFilterContext({
      definition: defWithValidation,
      input: { amount: -1 },
    });

    await zodFilter(ctx, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(false);
    expect(ctx.isError).toBe(true);
    expect(ctx.result).toBe("Amount must be positive");
  });
});

// --- createExecutorFilter ---

describe("createExecutorFilter", () => {
  test("executor 정상 실행 → 결과 설정", async () => {
    const executors = new Map<string, ToolExecutor>([
      ["test_tool", async () => '{"data": "result"}'],
    ]);
    const executorFilter = createExecutorFilter(executors);
    const ctx = makeFilterContext();

    await executorFilter(ctx, async () => {});

    expect(ctx.result).toBe('{"data": "result"}');
    expect(ctx.isError).toBeUndefined();
  });

  test("executor 없으면 에러", async () => {
    const executorFilter = createExecutorFilter(new Map());
    const ctx = makeFilterContext({ toolName: "unknown" });

    await executorFilter(ctx, async () => {});

    expect(ctx.isError).toBe(true);
    expect(ctx.result).toContain("Unknown tool");
  });

  test("executor 예외 → 에러 결과 (루프 중단 아님)", async () => {
    const executors = new Map<string, ToolExecutor>([
      ["test_tool", async () => { throw new Error("API failure"); }],
    ]);
    const executorFilter = createExecutorFilter(executors);
    const ctx = makeFilterContext();

    await executorFilter(ctx, async () => {});

    expect(ctx.isError).toBe(true);
    expect(ctx.result).toContain("API failure");
  });

  test("채널 도구 실행 시 channelDelivered 설정", async () => {
    const executors = new Map<string, ToolExecutor>([
      ["push_text_message", async () => "sent"],
    ]);
    const executorFilter = createExecutorFilter(executors);
    const ctx = makeFilterContext({ toolName: "push_text_message" });

    await executorFilter(ctx, async () => {});

    expect(ctx.channelDelivered).toBe(true);
  });
});

// --- 통합: 4필터 체인 ---

describe("4필터 체인 통합", () => {
  test("정상 흐름: logging → writeIntercept(pass) → zod(pass) → executor", async () => {
    const executors = new Map<string, ToolExecutor>([
      ["gmail_list", async () => '{"messages": []}'],
    ]);
    const def = gwsTool({
      name: "gmail_list",
      description: "List emails",
      inputSchema: z.object({}),
      requiredScopes: [],
      createExecutor: () => async () => "ok",
    });

    const filters: ToolFilter[] = [
      createLoggingFilter(),
      createZodValidationFilter(),
      createExecutorFilter(executors),
    ];

    const ctx = makeFilterContext({
      toolName: "gmail_list",
      definition: def,
    });

    await executeFilterChain(filters, ctx);

    expect(ctx.result).toBe('{"messages": []}');
    expect(ctx.isError).toBeUndefined();
  });

  test("Zod 실패 → executor 실행 안 됨", async () => {
    let executorCalled = false;
    const executors = new Map<string, ToolExecutor>([
      ["test_tool", async () => { executorCalled = true; return "ok"; }],
    ]);
    const def = gwsTool({
      name: "test_tool",
      description: "Test",
      inputSchema: z.object({ required_field: z.string() }),
      requiredScopes: [],
      createExecutor: () => async () => "ok",
    });

    const filters: ToolFilter[] = [
      createLoggingFilter(),
      createZodValidationFilter(),
      createExecutorFilter(executors),
    ];

    const ctx = makeFilterContext({
      toolName: "test_tool",
      definition: def,
      input: {}, // required_field 누락
    });

    await executeFilterChain(filters, ctx);

    expect(ctx.isError).toBe(true);
    expect(ctx.result).toContain("Input validation error");
    expect(executorCalled).toBe(false);
  });
});

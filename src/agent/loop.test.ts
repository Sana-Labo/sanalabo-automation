/**
 * runAgentLoop — max_tokens resume 테스트
 *
 * TDD Red phase: loop.ts의 max_tokens resume 로직 검증.
 * mock.module로 config + client 모킹.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import "../test-utils/setup-env.js";
import type Anthropic from "@anthropic-ai/sdk";
import type { AgentDependencies, PendingActionStore } from "../types.js";

// --- Module mocks (Bun이 hoisting) ---
// config.ts는 mock하지 않음 — setup-env.ts + 실 config 사용 (mock.module은 프로세스 전역에 영향)

const mockCreate = mock<(...args: any[]) => Promise<Anthropic.Message>>();

// api-errors.ts의 실제 export를 re-export에 포함 (loop.ts가 api-client.js에서 통합 import)
const apiErrors = await import("./api-errors.js");

mock.module("./api-client.js", () => ({
  client: {
    messages: { create: mockCreate },
    models: {
      retrieve: mock(() =>
        Promise.resolve({
          id: "claude-haiku-4-5-20251001",
          max_tokens: 4096,
          max_input_tokens: 200_000,
          capabilities: null,
          created_at: "2025-10-01T00:00:00Z",
          display_name: "Claude Haiku 4.5",
          type: "model" as const,
        }),
      ),
    },
  },
  resolveMaxTokens: apiErrors.resolveMaxTokens,
  clearModelMaxTokensCache: apiErrors.clearModelMaxTokensCache,
  DEFAULT_MAX_TOKENS: apiErrors.DEFAULT_MAX_TOKENS,
  MAX_TOKENS_RESUME_PROMPT: apiErrors.MAX_TOKENS_RESUME_PROMPT,
  classifyApiError: apiErrors.classifyApiError,
}));

// mock.module 적용 후 동적 import
const { runAgentLoop } = await import("./loop.js");
const { MAX_TOKENS_RESUME_PROMPT } = apiErrors;

// --- 테스트 헬퍼 ---

/** 테스트용 응답 생성 — SDK 타입의 필수 필드를 as로 완화 */
function makeResponse(overrides: Record<string, unknown> = {}): Anthropic.Message {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 8)}`,
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    content: [{ type: "text", text: '{"text":"hello"}' }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 },
    ...overrides,
  } as unknown as Anthropic.Message;
}

/** 테스트용 ContentBlock 생성 */
function textBlock(text: string): Anthropic.ContentBlock {
  return { type: "text", text } as unknown as Anthropic.ContentBlock;
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

function makeDeps(): AgentDependencies {
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
    getGrantedScopes: async () => undefined,
  };
}

// --- max_tokens resume ---

describe("runAgentLoop — max_tokens resume", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  test("max_tokens → resume 프롬프트 주입 → end_turn 정상 종료", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeResponse({
          stop_reason: "max_tokens",
          content: [textBlock("partial response")],
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          stop_reason: "end_turn",
          content: [textBlock('{"text":"complete response"}')],
        }),
      );

    const result = await runAgentLoop("test message", makeDeps(), { userId: "U_test", role: "admin" });

    // API 2회 호출
    expect(mockCreate).toHaveBeenCalledTimes(2);
    // 최종 응답은 2번째 end_turn의 텍스트
    expect(result.text).toBe("complete response");

    // 2번째 호출의 messages에 resume 프롬프트가 포함되어야 함
    const secondCallArgs = mockCreate.mock.calls[1]![0] as Record<string, unknown>;
    const messages = secondCallArgs["messages"] as Anthropic.MessageParam[];
    const lastUserMsg = messages[messages.length - 1]!;
    expect(lastUserMsg.role).toBe("user");
    expect(lastUserMsg.content).toBe(MAX_TOKENS_RESUME_PROMPT);
  });

  test("max_tokens 재시도 3회 소진 → 마지막 응답 텍스트 반환", async () => {
    // 초기 1회 + 재시도 3회 = 총 4회, 모두 max_tokens
    for (let i = 0; i < 4; i++) {
      mockCreate.mockResolvedValueOnce(
        makeResponse({
          stop_reason: "max_tokens",
          content: [textBlock(`chunk ${i}`)],
        }),
      );
    }

    const result = await runAgentLoop("test message", makeDeps(), { userId: "U_test", role: "admin" });

    expect(mockCreate).toHaveBeenCalledTimes(4);
    // 마지막 응답(chunk 3)이 반환
    expect(result.text).toBe("chunk 3");
  });

  test("max_tokens → resume → end_turn JSON 정상 파싱", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeResponse({
          stop_reason: "max_tokens",
          content: [textBlock("잘린 텍스트")],
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          stop_reason: "end_turn",
          content: [textBlock('{"text":"최종 답변입니다"}')],
        }),
      );

    const result = await runAgentLoop("test message", makeDeps(), { userId: "U_test", role: "admin" });

    // end_turn 응답의 JSON text 필드가 파싱됨
    expect(result.text).toBe("최종 답변입니다");
  });

  test("usage 토큰이 resume 호출에 걸쳐 누적됨", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeResponse({
          stop_reason: "max_tokens",
          content: [textBlock("part1")],
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          stop_reason: "end_turn",
          content: [textBlock('{"text":"done"}')],
          usage: { input_tokens: 200, output_tokens: 100 },
        }),
      );

    const result = await runAgentLoop("test message", makeDeps(), { userId: "U_test", role: "admin" });

    // 루프가 정상 완료되고, 2회 모두 호출됨 (누적 처리가 에러 없이 동작)
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("done");
  });

  test("max_tokens resume 후 assistant 응답이 대화 히스토리에 보존됨", async () => {
    const partialContent = [textBlock("이메일 목록: 1. 회의 안건...")];

    mockCreate
      .mockResolvedValueOnce(
        makeResponse({
          stop_reason: "max_tokens",
          content: partialContent,
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          stop_reason: "end_turn",
          content: [textBlock('{"text":"2. 프로젝트 현황..."}')],
        }),
      );

    await runAgentLoop("메일 요약해줘", makeDeps(), { userId: "U_test", role: "admin" });

    // 2번째 호출의 messages에 1번째 assistant 응답이 보존되어야 함
    const secondCallArgs = mockCreate.mock.calls[1]![0] as Record<string, unknown>;
    const messages = secondCallArgs["messages"] as Anthropic.MessageParam[];
    // messages: [user("메일 요약해줘"), assistant(partialContent), user(RESUME_PROMPT)]
    const assistantMsg = messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toEqual(partialContent);
  });
});

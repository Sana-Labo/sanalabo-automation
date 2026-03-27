/**
 * api-errors 에러 분류 + Models API 조회 테스트
 *
 * api-errors.ts는 Functional Core — config.ts 의존 없음.
 * 환경변수 설정이나 mock.module 없이 순수 함수를 직접 테스트.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import {
  classifyApiError,
  resolveMaxTokens,
  clearModelMaxTokensCache,
  type ApiErrorCategory,
  DEFAULT_MAX_TOKENS,
} from "./api-errors.js";

// --- classifyApiError ---

describe("classifyApiError", () => {
  const headers = new Headers();

  /** SDK의 정적 팩토리로 에러 생성 — status 기반으로 올바른 서브클래스 반환 */
  function makeApiError(status: number, errorType: string, message: string, h = headers) {
    return Anthropic.APIError.generate(
      status,
      { type: "error", error: { type: errorType, message } },
      message,
      h,
    );
  }

  test("429 → rate_limited", () => {
    const error = makeApiError(429, "rate_limit_error", "Rate limited");
    const result = classifyApiError(error);
    expect(result.category).toBe("rate_limited" satisfies ApiErrorCategory);
  });

  test("429 + retry-after 헤더 → retryAfterMs 추출", () => {
    const h = new Headers({ "retry-after": "30" });
    const error = makeApiError(429, "rate_limit_error", "Rate limited", h);
    const result = classifyApiError(error);
    expect(result.category).toBe("rate_limited");
    expect(result.retryAfterMs).toBe(30_000);
  });

  test("529 → overloaded", () => {
    const error = makeApiError(529, "overloaded_error", "Overloaded");
    expect(classifyApiError(error).category).toBe("overloaded");
  });

  test("400 + context length 메시지 → context_exceeded", () => {
    const error = makeApiError(
      400,
      "invalid_request_error",
      "prompt is too long: 200000 tokens > 200000 maximum",
    );
    expect(classifyApiError(error).category).toBe("context_exceeded");
  });

  test("400 + 일반 메시지 → unknown (context_exceeded 아님)", () => {
    const error = makeApiError(400, "invalid_request_error", "invalid model");
    expect(classifyApiError(error).category).toBe("unknown");
  });

  test("401 → authentication", () => {
    const error = makeApiError(401, "authentication_error", "Invalid API key");
    expect(classifyApiError(error).category).toBe("authentication");
  });

  test("네트워크 에러 → connection", () => {
    const error = new Anthropic.APIConnectionError({ message: "Connection refused" });
    expect(classifyApiError(error).category).toBe("connection");
  });

  test("일반 Error → unknown", () => {
    const error = new Error("something went wrong");
    const result = classifyApiError(error);
    expect(result.category).toBe("unknown");
    expect(result.message).toBe("something went wrong");
  });

  test("비-Error 값 → unknown", () => {
    const result = classifyApiError("string error");
    expect(result.category).toBe("unknown");
    expect(result.message).toBe("string error");
  });
});

// --- resolveMaxTokens ---

describe("resolveMaxTokens", () => {
  beforeEach(() => {
    clearModelMaxTokensCache();
  });

  /** Models API를 모킹한 가짜 클라이언트 */
  function createMockClient(maxTokens: number | null) {
    return {
      models: {
        retrieve: mock(() =>
          Promise.resolve({
            id: "claude-haiku-4-5-20251001",
            max_tokens: maxTokens,
            max_input_tokens: 200_000,
            capabilities: null,
            created_at: "2025-10-01T00:00:00Z",
            display_name: "Claude Haiku 4.5",
            type: "model" as const,
          }),
        ),
      },
    } as unknown as Anthropic;
  }

  /** Models API가 실패하는 가짜 클라이언트 */
  function createFailingClient() {
    return {
      models: {
        retrieve: mock(() => Promise.reject(new Error("Network error"))),
      },
    } as unknown as Anthropic;
  }

  test("환경변수 오버라이드가 있으면 API 호출 없이 반환", async () => {
    const mockClient = createMockClient(8192);
    const result = await resolveMaxTokens(mockClient, "claude-haiku-4-5-20251001", 2048);
    expect(result).toBe(2048);
    expect(mockClient.models.retrieve).not.toHaveBeenCalled();
  });

  test("Models API 조회 성공 → max_tokens 반환", async () => {
    const mockClient = createMockClient(8192);
    const result = await resolveMaxTokens(mockClient, "claude-haiku-4-5-20251001");
    expect(result).toBe(8192);
    expect(mockClient.models.retrieve).toHaveBeenCalledTimes(1);
  });

  test("Models API가 null 반환 → 기본값 폴백", async () => {
    const mockClient = createMockClient(null);
    const result = await resolveMaxTokens(mockClient, "unknown-model");
    expect(result).toBe(DEFAULT_MAX_TOKENS);
  });

  test("Models API 실패 → 기본값 폴백", async () => {
    const mockClient = createFailingClient();
    const result = await resolveMaxTokens(mockClient, "unknown-failing-model");
    expect(result).toBe(DEFAULT_MAX_TOKENS);
    expect(mockClient.models.retrieve).toHaveBeenCalledTimes(1);
  });
});

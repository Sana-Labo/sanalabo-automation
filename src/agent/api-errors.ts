/**
 * Anthropic API 에러 분류 + 모델 정보 조회 (Functional Core)
 *
 * config.ts 의존 없음 — 순수 함수만 포함.
 * 필요한 값은 모두 파라미터로 주입 (DI).
 *
 * 책임:
 * - API 에러를 행동 가능한 카테고리로 분류
 * - Models API를 통한 모델별 max_tokens 런타임 조회 + 캐싱
 */
import Anthropic from "@anthropic-ai/sdk";
import { createLogger } from "../utils/logger.js";

const log = createLogger("api-errors");

// --- Error Classification ---

/** API 에러 분류 카테고리 */
export type ApiErrorCategory =
  | "rate_limited"       // 429 — 요청 한도 초과
  | "overloaded"         // 529 — 서버 과부하
  | "context_exceeded"   // 400 — 컨텍스트 윈도우 초과
  | "authentication"     // 401 — 인증 실패
  | "connection"         // 네트워크 에러
  | "unknown";

/** 에러 분류 결과 */
export interface ApiErrorResult {
  category: ApiErrorCategory;
  /** 429 응답의 retry-after 헤더 값 (밀리초). 없으면 undefined */
  retryAfterMs?: number;
  message: string;
}

/**
 * Anthropic API 에러를 행동 가능한 카테고리로 분류
 *
 * SDK 에러 클래스 계층을 활용:
 * - `RateLimitError` (429) → rate_limited + retry-after 파싱
 * - `InternalServerError` (529) → overloaded
 * - `BadRequestError` (400) + context 관련 메시지 → context_exceeded
 * - `AuthenticationError` (401) → authentication
 * - `APIConnectionError` → connection
 */
export function classifyApiError(error: unknown): ApiErrorResult {
  if (error instanceof Anthropic.APIConnectionError) {
    return { category: "connection", message: error.message };
  }

  if (error instanceof Anthropic.APIError) {
    const message = error.message;

    // 429 Rate Limit
    if (error.status === 429) {
      return {
        category: "rate_limited",
        retryAfterMs: parseRetryAfter(error.headers),
        message,
      };
    }

    // 529 Overloaded
    if (error.status === 529) {
      return { category: "overloaded", message };
    }

    // 401 Authentication
    if (error.status === 401) {
      return { category: "authentication", message };
    }

    // 400 Context Length Exceeded
    if (error.status === 400 && isContextLengthError(message)) {
      return { category: "context_exceeded", message };
    }

    return { category: "unknown", message };
  }

  // 비-SDK 에러
  const message = error instanceof Error ? error.message : String(error);
  return { category: "unknown", message };
}

/** retry-after 헤더 파싱 (초 → 밀리초) */
function parseRetryAfter(headers: Headers | undefined): number | undefined {
  const value = headers?.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return undefined;
}

/** 컨텍스트 길이 초과 에러 메시지 판별 */
function isContextLengthError(message: string): boolean {
  return message.includes("too long") || message.includes("too many tokens");
}

// --- Resume Prompt ---

/** max_tokens 도달 시 resume 프롬프트 (Claude Code 참조) */
export const MAX_TOKENS_RESUME_PROMPT =
  "Output token limit hit. Resume directly -- no apology, no recap of what you were doing. " +
  "Pick up mid-thought if that is where the cut happened. " +
  "Break remaining work into smaller pieces.";

// --- Model Limits ---

/** Models API 조회 실패 시 폴백 기본값 */
export const DEFAULT_MAX_TOKENS = 4096;

/** 모델별 max_tokens 인메모리 캐시 */
const modelMaxTokensCache = new Map<string, number>();

/**
 * 모델의 max_tokens를 해결
 *
 * 우선순위: 환경변수 오버라이드 > Models API 조회 (캐싱) > 기본값 4096
 *
 * @param apiClient - Anthropic 클라이언트 (DI: 테스트에서 모킹 가능)
 * @param modelId - 모델 ID (e.g. "claude-haiku-4-5-20251001")
 * @param envOverride - 환경변수 설정값 (config.agentMaxTokens)
 */
export async function resolveMaxTokens(
  apiClient: Anthropic,
  modelId: string,
  envOverride?: number,
): Promise<number> {
  if (envOverride !== undefined) return envOverride;

  const cached = modelMaxTokensCache.get(modelId);
  if (cached !== undefined) return cached;

  try {
    const model = await apiClient.models.retrieve(modelId);
    const maxTokens = model.max_tokens ?? DEFAULT_MAX_TOKENS;
    modelMaxTokensCache.set(modelId, maxTokens);
    log.info("Model limits resolved", { modelId, maxTokens, maxInputTokens: model.max_input_tokens });
    return maxTokens;
  } catch (e) {
    log.warning("Models API 조회 실패, 기본값 사용", {
      modelId,
      error: e instanceof Error ? e.message : String(e),
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
    });
    return DEFAULT_MAX_TOKENS;
  }
}

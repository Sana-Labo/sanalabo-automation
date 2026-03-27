/**
 * Anthropic API 클라이언트 (Imperative Shell)
 *
 * 책임:
 * - Anthropic 클라이언트 인스턴스 생성 (config 의존)
 * - api-errors.ts의 순수 유틸리티를 re-export
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

/** Anthropic API 클라이언트 (싱글턴) */
export const client = new Anthropic({ apiKey: config.anthropicApiKey });

// 유틸리티 re-export — 소비측 import 경로 통합
export {
  classifyApiError,
  resolveMaxTokens,
  clearModelMaxTokensCache,
  DEFAULT_MAX_TOKENS,
  MAX_TOKENS_RESUME_PROMPT,
  type ApiErrorCategory,
  type ApiErrorResult,
} from "./api-errors.js";

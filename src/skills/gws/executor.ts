/**
 * GWS Executor — Google Workspace API 기반 도구 실행 팩토리
 *
 * TokenStore에서 토큰 로드 → OAuth2Client 생성 → googleapis 서비스 클라이언트 → executor Map.
 * 워크스페이스별 캐시 지원. 토큰 회전 시 자동 저장.
 */

import { gmail } from "@googleapis/gmail";
import { calendar } from "@googleapis/calendar";
import { drive } from "@googleapis/drive";
import {
  createOAuth2Client,
  configureClient,
  type GoogleAuthConfig,
} from "./google-auth.js";
import { createApiExecutors } from "./api-executor.js";
import type { TokenStore, GoogleTokens } from "./token-store.js";
import type { ToolExecutor } from "../../types.js";
import { toErrorMessage } from "../../utils/error.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("gws");

/** Google API auth 에러 판별 (토큰 폐지/만료) */
function isAuthError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const msg = e.message.toLowerCase();
  const code = (e as unknown as { code?: number }).code;
  return msg.includes("invalid_grant") ||
    msg.includes("token has been expired or revoked") ||
    (typeof code === "number" && (code === 401 || code === 403));
}

/**
 * executor를 auth 에러 감지 래퍼로 래핑
 *
 * Google API 호출에서 토큰 폐지/만료 에러 발생 시 캐시를 자동 무효화.
 * 다음 호출에서 TokenStore로부터 토큰을 재로드하여 복구 시도.
 */
function withAuthErrorInvalidation(
  executors: Map<string, ToolExecutor>,
  workspaceId: string,
  cache: Map<string, Map<string, ToolExecutor>>,
): Map<string, ToolExecutor> {
  const wrapped = new Map<string, ToolExecutor>();
  for (const [name, exec] of executors) {
    wrapped.set(name, async (input) => {
      try {
        return await exec(input);
      } catch (e) {
        if (isAuthError(e)) {
          cache.delete(workspaceId);
          log.warning("Auth error detected, cache invalidated", { workspaceId, tool: name });
        }
        throw e;
      }
    });
  }
  return wrapped;
}

/**
 * GWS executor 팩토리 생성
 *
 * TokenStore + GoogleAuthConfig를 캡처한 클로저를 반환.
 * 반환된 함수는 `AgentDependencies.getGwsExecutors`로 주입.
 *
 * @param tokenStore - 암호화 토큰 저장소
 * @param authConfig - Google OAuth 설정
 * @returns 팩토리 함수 + invalidate 메서드
 */
export function createGwsExecutorFactory(
  tokenStore: TokenStore,
  authConfig: GoogleAuthConfig,
): {
  getExecutors: (workspaceId: string) => Promise<Map<string, ToolExecutor> | null>;
  invalidate: (workspaceId?: string) => void;
} {
  const cache = new Map<string, Map<string, ToolExecutor>>();

  const getExecutors = async (workspaceId: string): Promise<Map<string, ToolExecutor> | null> => {
    // 캐시 히트
    const cached = cache.get(workspaceId);
    if (cached) return cached;

    // 토큰 로드
    const tokens = await tokenStore.load(workspaceId);
    if (!tokens) {
      log.debug("No tokens for workspace", { workspaceId });
      return null;
    }

    // OAuth2Client 생성 + 토큰 회전 핸들러 (W3: 에러 핸들링 추가)
    const auth = createOAuth2Client(authConfig);
    configureClient(auth, tokens, async (updated: GoogleTokens) => {
      try {
        await tokenStore.save(workspaceId, updated);
        log.info("Token rotated and saved", { workspaceId });
      } catch (e) {
        log.error("Failed to save rotated token", { workspaceId, error: toErrorMessage(e) });
      }
    });

    // googleapis 서비스 클라이언트 생성
    const gmailClient = gmail({ version: "v1", auth });
    const calendarClient = calendar({ version: "v3", auth });
    const driveClient = drive({ version: "v3", auth });

    // executor Map 생성 + auth 에러 감지 래핑 (C2) + 캐시
    const rawExecutors = createApiExecutors(gmailClient, calendarClient, driveClient);
    const executors = withAuthErrorInvalidation(rawExecutors, workspaceId, cache);
    cache.set(workspaceId, executors);
    log.debug("GWS executors created", { workspaceId, toolCount: executors.size });

    return executors;
  };

  const invalidate = (workspaceId?: string): void => {
    if (workspaceId) {
      cache.delete(workspaceId);
    } else {
      cache.clear();
    }
  };

  return { getExecutors, invalidate };
}

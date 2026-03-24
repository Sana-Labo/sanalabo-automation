/**
 * GWS Executor — Google Workspace API 기반 도구 실행 팩토리
 *
 * TokenStore에서 토큰 로드 → OAuth2Client 생성 → googleapis 서비스 클라이언트 → executor Map.
 * 워크스페이스별 캐시 지원. 토큰 회전 시 자동 저장.
 *
 * GwsToolDefinition의 createExecutor를 순회하여 executor 생성.
 */

import { gmail } from "@googleapis/gmail";
import { calendar } from "@googleapis/calendar";
import { drive } from "@googleapis/drive";
import {
  createOAuth2Client,
  configureClient,
  type GoogleAuthConfig,
} from "./google-auth.js";
import { gwsToolDefinitions } from "./tools.js";
import type { TokenStore, GoogleTokens } from "./token-store.js";
import type { ToolExecutor } from "../../types.js";
import { hasSufficientScopes } from "../../domain/google-scopes.js";
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
  const inFlight = new Map<string, Promise<Map<string, ToolExecutor> | null>>();

  async function buildExecutors(workspaceId: string): Promise<Map<string, ToolExecutor> | null> {
    const tokens = await tokenStore.load(workspaceId);
    if (!tokens) {
      log.debug("No tokens for workspace", { workspaceId });
      return null;
    }

    // OAuth2Client 생성 + 토큰 회전 핸들러
    const auth = createOAuth2Client(authConfig);
    configureClient(auth, tokens, async (updated: GoogleTokens) => {
      try {
        await tokenStore.save(workspaceId, updated);
        log.info("Token rotated and saved", { workspaceId });
      } catch (e) {
        log.error("Failed to save rotated token", { workspaceId, error: toErrorMessage(e) });
      }
    });

    const gmailClient = gmail({ version: "v1", auth });
    const calendarClient = calendar({ version: "v3", auth });
    const driveClient = drive({ version: "v3", auth });
    const services = { auth, gmail: gmailClient, calendar: calendarClient, drive: driveClient };

    // GwsToolDefinition 순회 → scope 충족 도구만 executor 생성 (A-3 필터링)
    const rawExecutors = new Map<string, ToolExecutor>();
    for (const def of gwsToolDefinitions) {
      if (!hasSufficientScopes(tokens.scope, def.requiredScopes)) {
        log.debug("Skipping tool (insufficient scopes)", { tool: def.name, workspaceId });
        continue;
      }
      const typedExecutor = def.createExecutor(services);
      rawExecutors.set(def.name, (input) => typedExecutor(input as any));
    }

    // auth 에러 감지 → 캐시 무효화 → re-throw.
    // 에러→문자열 변환은 loop.ts catch (is_error: true)에 일원화
    const executors = withAuthErrorInvalidation(rawExecutors, workspaceId, cache);
    cache.set(workspaceId, executors);
    log.debug("GWS executors created", { workspaceId, toolCount: executors.size });

    return executors;
  }

  const getExecutors = (workspaceId: string): Promise<Map<string, ToolExecutor> | null> => {
    const cached = cache.get(workspaceId);
    if (cached) return Promise.resolve(cached);

    // in-flight 중복 방지: 동일 workspaceId에 대한 동시 빌드 경합 차단
    const pending = inFlight.get(workspaceId);
    if (pending) return pending;

    const p = buildExecutors(workspaceId).finally(() => inFlight.delete(workspaceId));
    inFlight.set(workspaceId, p);
    return p;
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

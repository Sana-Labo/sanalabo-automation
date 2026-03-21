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
import { createLogger } from "../../utils/logger.js";

const log = createLogger("gws");

/** GWS executor 캐시 (workspaceId → executor Map) */
const executorCache = new Map<string, Map<string, ToolExecutor>>();

/**
 * GWS executor 팩토리 생성
 *
 * TokenStore + GoogleAuthConfig를 캡처한 클로저를 반환.
 * 반환된 함수는 `AgentDependencies.getGwsExecutors`로 주입.
 *
 * @param tokenStore - 암호화 토큰 저장소
 * @param authConfig - Google OAuth 설정
 */
export function createGwsExecutorFactory(
  tokenStore: TokenStore,
  authConfig: GoogleAuthConfig,
): (workspaceId: string) => Promise<Map<string, ToolExecutor> | null> {
  return async (workspaceId: string) => {
    // 캐시 히트
    const cached = executorCache.get(workspaceId);
    if (cached) return cached;

    // 토큰 로드
    const tokens = await tokenStore.load(workspaceId);
    if (!tokens) {
      log.debug("No tokens for workspace", { workspaceId });
      return null;
    }

    // OAuth2Client 생성 + 토큰 회전 핸들러
    const auth = createOAuth2Client(authConfig);
    configureClient(auth, tokens, async (updated: GoogleTokens) => {
      await tokenStore.save(workspaceId, updated);
      log.info("Token rotated and saved", { workspaceId });
    });

    // googleapis 서비스 클라이언트 생성
    const gmailClient = gmail({ version: "v1", auth });
    const calendarClient = calendar({ version: "v3", auth });
    const driveClient = drive({ version: "v3", auth });

    // executor Map 생성 + 캐시
    const executors = createApiExecutors(gmailClient, calendarClient, driveClient);
    executorCache.set(workspaceId, executors);
    log.debug("GWS executors created", { workspaceId, toolCount: executors.size });

    return executors;
  };
}

/**
 * GWS executor 캐시 무효화
 *
 * 토큰 갱신/삭제, 워크스페이스 삭제 시 호출하여 stale executor 제거.
 *
 * @param workspaceId - 특정 워크스페이스만 무효화. 미지정 시 전체 클리어
 */
export function invalidateGwsExecutors(workspaceId?: string): void {
  if (workspaceId) {
    executorCache.delete(workspaceId);
  } else {
    executorCache.clear();
  }
}

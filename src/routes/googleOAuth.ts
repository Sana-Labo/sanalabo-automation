/**
 * Google OAuth 콜백 라우트
 *
 * GET /auth/google/callback — Google이 인가 코드를 전달하는 엔드포인트.
 * state 검증 → 코드→토큰 교환 → 암호화 저장 → LINE push 통지 → HTML 응답.
 */

import { Hono } from "hono";
import { parseCallbackQuery } from "../domain/google-oauth.js";
import {
  createOAuth2Client,
  exchangeCode,
  type GoogleAuthConfig,
} from "../skills/gws/google-auth.js";
import { consumePendingAuth } from "../skills/gws/oauth-state.js";
import type { TokenStore } from "../skills/gws/token-store.js";
import {
  LINE_PUSH_TEXT_TOOL,
  type ToolRegistry,
  type WorkspaceStore,
} from "../types.js";
import { toErrorMessage } from "../utils/error.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("oauth");

/** OAuth 콜백 라우트 의존성 */
export interface GoogleOAuthRouteDeps {
  tokenStore: TokenStore;
  workspaceStore: WorkspaceStore;
  authConfig: GoogleAuthConfig;
  registry: ToolRegistry;
  /** GWS executor 캐시 무효화 (새 토큰으로 재생성 유도) */
  invalidateExecutors: (workspaceId: string) => void;
}

/** HTML 이스케이프 (XSS 방지) */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 성공/에러 HTML 응답 */
function htmlResponse(title: string, message: string): Response {
  const t = escapeHtml(title);
  const m = escapeHtml(message);
  return new Response(
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${t}</title>
<style>body{font-family:sans-serif;text-align:center;padding:60px 20px}h1{font-size:24px}p{color:#666}</style>
</head><body><h1>${t}</h1><p>${m}</p></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

/**
 * Google OAuth 콜백 라우트 생성
 *
 * @param deps - TokenStore, WorkspaceStore, AuthConfig, Registry
 * @returns Hono 앱 (GET /auth/google/callback)
 */
export function createGoogleOAuthRoute(deps: GoogleOAuthRouteDeps): Hono {
  const app = new Hono();

  app.get("/auth/google/callback", async (c) => {
    // 1. 콜백 파라미터 파싱 (Hono 내장 쿼리 파서 사용)
    const query = c.req.query();
    const parsed = parseCallbackQuery(query);
    if (!parsed.ok) {
      log.warning("OAuth callback error", { error: parsed.error });
      return htmlResponse("Authentication Failed", parsed.error);
    }

    // 2. state 검증 (1회성 소비)
    const auth = consumePendingAuth(parsed.params.state);
    if (!auth) {
      log.warning("Invalid or expired OAuth state");
      return htmlResponse(
        "Authentication Failed",
        "Invalid or expired authentication link. Please request a new one.",
      );
    }

    // 3. 인가 코드 → 토큰 교환
    try {
      const client = createOAuth2Client(deps.authConfig);
      const tokens = await exchangeCode(client, parsed.params.code);

      // 4. 토큰 암호화 저장
      await deps.tokenStore.save(auth.workspaceId, tokens);

      // 5. gwsAuthenticated 플래그 설정
      await deps.workspaceStore.setGwsAuthenticated(auth.workspaceId, true);

      // 6. GWS executor 캐시 무효화 (새 토큰으로 재생성 유도)
      deps.invalidateExecutors(auth.workspaceId);

      log.info("OAuth completed", {
        userId: auth.userId,
        workspaceId: auth.workspaceId,
      });

      // 7. LINE push로 완료 통지
      const textExecutor = deps.registry.executors.get(LINE_PUSH_TEXT_TOOL);
      if (textExecutor) {
        textExecutor({
          user_id: auth.userId,
          messages: [
            {
              type: "text",
              text: "Google Workspace authentication completed! You can now use email, calendar, and drive features.",
            },
          ],
        }).catch((e) => {
          log.error("Failed to send completion notification", {
            error: toErrorMessage(e),
          });
        });
      }

      // 8. 브라우저에 성공 HTML
      return htmlResponse(
        "Authentication Complete",
        "You can close this window and return to LINE.",
      );
    } catch (e) {
      log.error("OAuth token exchange failed", {
        workspaceId: auth.workspaceId,
        error: toErrorMessage(e),
      });
      return htmlResponse(
        "Authentication Failed",
        "Failed to complete authentication. Please try again.",
      );
    }
  });

  return app;
}

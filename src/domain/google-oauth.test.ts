import { describe, test, expect } from "bun:test";
import {
  GOOGLE_SCOPES,
  buildConsentUrl,
  parseCallbackQuery,
  isAuthExpired,
  type PendingAuth,
} from "./google-oauth.js";

describe("google-oauth domain", () => {
  describe("GOOGLE_SCOPES", () => {
    test("gmail.modify, calendar, drive スコープを含む", () => {
      expect(GOOGLE_SCOPES).toContain(
        "https://www.googleapis.com/auth/gmail.modify",
      );
      expect(GOOGLE_SCOPES).toContain(
        "https://www.googleapis.com/auth/calendar",
      );
      expect(GOOGLE_SCOPES).toContain(
        "https://www.googleapis.com/auth/drive",
      );
    });

    test("3개 이상의 스코프 포함", () => {
      expect(GOOGLE_SCOPES.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("buildConsentUrl", () => {
    const baseParams = {
      clientId: "test-client-id",
      redirectUri: "https://example.com/auth/google/callback",
      state: "random-state-123",
    };

    test("올바른 Google OAuth URL 생성", () => {
      const url = new URL(buildConsentUrl(baseParams));
      expect(url.origin + url.pathname).toBe(
        "https://accounts.google.com/o/oauth2/v2/auth",
      );
    });

    test("필수 파라미터 포함", () => {
      const url = new URL(buildConsentUrl(baseParams));
      expect(url.searchParams.get("client_id")).toBe("test-client-id");
      expect(url.searchParams.get("redirect_uri")).toBe(
        "https://example.com/auth/google/callback",
      );
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("access_type")).toBe("offline");
      expect(url.searchParams.get("prompt")).toBe("consent");
      expect(url.searchParams.get("state")).toBe("random-state-123");
    });

    test("기본 스코프 사용", () => {
      const url = new URL(buildConsentUrl(baseParams));
      const scope = url.searchParams.get("scope")!;
      for (const s of GOOGLE_SCOPES) {
        expect(scope).toContain(s);
      }
    });

    test("커스텀 스코프 지정 가능", () => {
      const customScopes = ["https://www.googleapis.com/auth/gmail.readonly"];
      const url = new URL(
        buildConsentUrl({ ...baseParams, scopes: customScopes }),
      );
      expect(url.searchParams.get("scope")).toBe(customScopes[0]!);
    });
  });

  describe("parseCallbackQuery", () => {
    test("유효한 콜백 파라미터 파싱", () => {
      const result = parseCallbackQuery({
        code: "auth-code-123",
        state: "state-456",
      });
      expect(result).toEqual({
        ok: true,
        params: { code: "auth-code-123", state: "state-456" },
      });
    });

    test("Google OAuth 에러 반환 시 실패", () => {
      const result = parseCallbackQuery({
        error: "access_denied",
      });
      expect(result).toEqual({
        ok: false,
        error: "Google OAuth error: access_denied",
      });
    });

    test("code 누락 시 실패", () => {
      const result = parseCallbackQuery({ state: "state-456" });
      expect(result).toEqual({
        ok: false,
        error: "Missing authorization code",
      });
    });

    test("state 누락 시 실패", () => {
      const result = parseCallbackQuery({ code: "auth-code-123" });
      expect(result).toEqual({
        ok: false,
        error: "Missing state parameter",
      });
    });
  });

  describe("isAuthExpired", () => {
    test("만료 시간 이전이면 false", () => {
      const auth: PendingAuth = {
        userId: "U001",
        workspaceId: "ws-1",
        expiresAt: Date.now() + 60_000,
      };
      expect(isAuthExpired(auth)).toBe(false);
    });

    test("만료 시간 이후이면 true", () => {
      const auth: PendingAuth = {
        userId: "U001",
        workspaceId: "ws-1",
        expiresAt: Date.now() - 1,
      };
      expect(isAuthExpired(auth)).toBe(true);
    });
  });
});

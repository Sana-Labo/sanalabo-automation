import "../test-utils/setup-env.js";
import { describe, test, expect, beforeEach } from "bun:test";
import { createGoogleOAuthRoute, type GoogleOAuthRouteDeps } from "./googleOAuth.js";
import { createPendingAuth, _resetForTest } from "../skills/gws/oauth-state.js";

/** 기록용 배열 */
let savedTokens: Array<{ workspaceId: string; tokens: unknown }>;
let authenticatedWs: string[];
let savedAccounts: Array<{ workspaceId: string; account: unknown }>;
let invalidatedWs: string[];
let pushMessages: Array<{ userId: string; message: unknown }>;

function createMockDeps(overrides?: {
  exchangeCode?: GoogleOAuthRouteDeps["_exchangeCode"];
  fetchUserInfo?: GoogleOAuthRouteDeps["_fetchUserInfo"];
}): GoogleOAuthRouteDeps {
  savedTokens = [];
  authenticatedWs = [];
  savedAccounts = [];
  invalidatedWs = [];
  pushMessages = [];

  return {
    tokenStore: {
      save: async (workspaceId: string, tokens: unknown) => {
        savedTokens.push({ workspaceId, tokens });
      },
      load: async () => null,
      delete: async () => {},
    } as GoogleOAuthRouteDeps["tokenStore"],
    workspaceStore: {
      setGwsAuthenticated: async (workspaceId: string) => {
        authenticatedWs.push(workspaceId);
      },
      setGwsAccount: async (workspaceId: string, account: unknown) => {
        savedAccounts.push({ workspaceId, account });
      },
    } as unknown as GoogleOAuthRouteDeps["workspaceStore"],
    invalidateExecutors: (workspaceId: string) => {
      invalidatedWs.push(workspaceId);
    },
    authConfig: {
      clientId: "test-client",
      clientSecret: "test-secret",
      redirectUri: "https://example.com/auth/google/callback",
    },
    registry: {
      definitions: [],
      executors: new Map([
        [
          "push_text_message",
          async (input: Record<string, unknown>) => {
            pushMessages.push({
              userId: input.userId as string,
              message: input.message,
            });
            return "ok";
          },
        ],
      ]),
    } as unknown as GoogleOAuthRouteDeps["registry"],
    _exchangeCode: overrides?.exchangeCode ?? (async () => ({
      access_token: "test-access",
      refresh_token: "test-refresh",
      expiry_date: Date.now() + 3600_000,
      scope: "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/drive openid email profile",
    })),
    _fetchUserInfo: overrides?.fetchUserInfo ?? (async () => ({
      email: "test@example.com",
      name: "Test User",
      picture: "https://example.com/pic.jpg",
    })),
  };
}

describe("GET /auth/google/callback", () => {
  let app: ReturnType<typeof createGoogleOAuthRoute>;

  beforeEach(() => {
    _resetForTest();
    app = createGoogleOAuthRoute(createMockDeps());
  });

  test("state 누락 시 에러 HTML", async () => {
    const res = await app.request("/auth/google/callback?code=test-code");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Missing state parameter");
  });

  test("code 누락 시 에러 HTML", async () => {
    const res = await app.request("/auth/google/callback?state=test-state");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Missing authorization code");
  });

  test("Google OAuth error 파라미터 시 에러 HTML", async () => {
    const res = await app.request(
      "/auth/google/callback?error=access_denied",
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("access_denied");
  });

  test("잘못된/만료된 state 시 에러 HTML", async () => {
    const res = await app.request(
      "/auth/google/callback?code=test-code&state=invalid-state",
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("expired");
  });

  test("성공 경로: 토큰 교환 → 저장 → 프로필 → 통지 → HTML", async () => {
    const state = createPendingAuth("U001", "ws-1");

    const res = await app.request(
      `/auth/google/callback?code=auth-code&state=${state}`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Authentication Complete");

    // 토큰 저장
    expect(savedTokens).toHaveLength(1);
    expect(savedTokens[0]!.workspaceId).toBe("ws-1");

    // GWS 인증 플래그
    expect(authenticatedWs).toEqual(["ws-1"]);

    // 프로필 저장
    expect(savedAccounts).toHaveLength(1);
    expect(savedAccounts[0]!.workspaceId).toBe("ws-1");

    // executor 캐시 무효화
    expect(invalidatedWs).toEqual(["ws-1"]);

    // LINE push 통지
    expect(pushMessages).toHaveLength(1);
    expect(pushMessages[0]!.userId).toBe("U001");
  });

  test("토큰 교환 실패 시 에러 HTML", async () => {
    app = createGoogleOAuthRoute(createMockDeps({
      exchangeCode: async () => { throw new Error("Token exchange failed"); },
    }));
    const state = createPendingAuth("U001", "ws-1");

    const res = await app.request(
      `/auth/google/callback?code=bad-code&state=${state}`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Authentication Failed");
    expect(html).toContain("Failed to complete authentication");
  });

  test("프로필 조회 실패해도 인증은 성공 (best-effort)", async () => {
    app = createGoogleOAuthRoute(createMockDeps({
      fetchUserInfo: async () => { throw new Error("Userinfo API error"); },
    }));
    const state = createPendingAuth("U001", "ws-1");

    const res = await app.request(
      `/auth/google/callback?code=auth-code&state=${state}`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Authentication Complete");

    // 토큰은 저장됨
    expect(savedTokens).toHaveLength(1);
    // 프로필은 저장 안 됨
    expect(savedAccounts).toHaveLength(0);
  });

  test("부분 승인: gmail scope만 부여 → unavailable 서비스 안내", async () => {
    app = createGoogleOAuthRoute(createMockDeps({
      exchangeCode: async () => ({
        access_token: "test-access",
        refresh_token: "test-refresh",
        expiry_date: Date.now() + 3600_000,
        scope: "https://www.googleapis.com/auth/gmail.modify openid email profile",
      }),
    }));
    const state = createPendingAuth("U001", "ws-1");

    await app.request(`/auth/google/callback?code=auth-code&state=${state}`);

    expect(pushMessages).toHaveLength(1);
    const msg = (pushMessages[0]!.message as { text: string }).text;
    expect(msg).toContain("Gmail");
    expect(msg).toContain("Not authorized");
    expect(msg).toContain("Calendar");
    expect(msg).toContain("Drive");
  });

  test("전체 승인: 기존 메시지 유지", async () => {
    const state = createPendingAuth("U001", "ws-1");

    await app.request(`/auth/google/callback?code=auth-code&state=${state}`);

    expect(pushMessages).toHaveLength(1);
    const msg = (pushMessages[0]!.message as { text: string }).text;
    expect(msg).toContain("email, calendar, and drive features");
    expect(msg).not.toContain("Not authorized");
  });
});

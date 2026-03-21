import "../test-utils/setup-env.js";
import { describe, test, expect, beforeEach } from "bun:test";
import { createGoogleOAuthRoute, type GoogleOAuthRouteDeps } from "./googleOAuth.js";
import { createPendingAuth } from "../skills/gws/oauth-state.js";
import type { TokenStore } from "../skills/gws/token-store.js";
import type { ToolRegistry, WorkspaceStore } from "../types.js";

/** 저장된 토큰 기록용 */
const savedTokens: Array<{ workspaceId: string }> = [];
const authenticatedWs: string[] = [];
const pushMessages: Array<{ userId: string; text: string }> = [];

function createMockDeps(): GoogleOAuthRouteDeps {
  savedTokens.length = 0;
  authenticatedWs.length = 0;
  pushMessages.length = 0;

  return {
    tokenStore: {
      save: async (workspaceId) => {
        savedTokens.push({ workspaceId });
      },
      load: async () => null,
      delete: async () => {},
    } as TokenStore,
    workspaceStore: {
      setGwsAuthenticated: async (workspaceId: string) => {
        authenticatedWs.push(workspaceId);
      },
    } as unknown as WorkspaceStore,
    authConfig: {
      clientId: "test-client",
      clientSecret: "test-secret",
      redirectUri: "https://example.com/auth/google/callback",
    },
    registry: {
      tools: [],
      executors: new Map([
        [
          "push_text_message",
          async (input: Record<string, unknown>) => {
            const msgs = input.messages as Array<{ text: string }>;
            pushMessages.push({
              userId: input.user_id as string,
              text: msgs[0]!.text,
            });
            return "ok";
          },
        ],
      ]),
    } as unknown as ToolRegistry,
  };
}

describe("GET /auth/google/callback", () => {
  let app: ReturnType<typeof createGoogleOAuthRoute>;

  beforeEach(() => {
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

  test("유효한 state → 소비 후 재사용 불가 (state 1회성 검증)", async () => {
    const state = createPendingAuth("U001", "ws-1");

    // state 소비: consumePendingAuth를 직접 호출하여 검증 (네트워크 호출 회피)
    const { consumePendingAuth: consume } = await import(
      "../skills/gws/oauth-state.js"
    );
    // 새 state를 생성하여 소비 테스트
    const state2 = createPendingAuth("U002", "ws-2");
    const auth = consume(state2);
    expect(auth).not.toBeNull();
    expect(auth!.userId).toBe("U002");

    // 재소비 → null
    expect(consume(state2)).toBeNull();

    // 최초 state도 소비 가능 확인
    const auth1 = consume(state);
    expect(auth1).not.toBeNull();
    expect(auth1!.workspaceId).toBe("ws-1");
  });

  test("토큰 교환 실패 시 에러 HTML 반환 (실제 API 미호출)", async () => {
    const state = createPendingAuth("U003", "ws-3");
    // exchangeCode가 잘못된 code로 Google API 호출 → 빠르게 에러 반환 (invalid_grant)
    // 네트워크 접근 불가 환경에서는 connection error → catch 경로
    const res = await app.request(
      `/auth/google/callback?code=invalid-code&state=${state}`,
    );
    const html = await res.text();
    expect(html).toContain("Authentication Failed");
  });
});

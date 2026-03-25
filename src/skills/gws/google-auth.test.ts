import { describe, test, expect, mock } from "bun:test";
import { OAuth2Client } from "google-auth-library";
import {
  createOAuth2Client,
  configureClient,
  exchangeCode,
  type GoogleAuthConfig,
} from "./google-auth.js";
import type { GoogleTokens } from "./token-store.js";

const testConfig: GoogleAuthConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  redirectUri: "https://example.com/auth/google/callback",
};

describe("createOAuth2Client", () => {
  test("OAuth2Client 인스턴스 생성", () => {
    const client = createOAuth2Client(testConfig);
    expect(client).toBeInstanceOf(OAuth2Client);
  });
});

describe("configureClient", () => {
  test("refresh_token 설정", () => {
    const client = createOAuth2Client(testConfig);
    const tokens: GoogleTokens = { refresh_token: "1//test-refresh" };

    configureClient(client, tokens);

    const creds = client.credentials;
    expect(creds.refresh_token).toBe("1//test-refresh");
  });

  test("토큰 회전 시 onTokenRefresh 콜백 호출", () => {
    const client = createOAuth2Client(testConfig);
    const tokens: GoogleTokens = { refresh_token: "1//old-refresh" };
    const callback = mock((_updated: GoogleTokens) => {});

    configureClient(client, tokens, callback);

    // tokens 이벤트 시뮬레이션
    client.emit("tokens", {
      refresh_token: "1//new-refresh",
      access_token: "ya29.new-access",
      expiry_date: 9999999999999,
    });

    expect(callback).toHaveBeenCalledTimes(1);
    const updated = callback.mock.calls[0]![0];
    expect(updated.refresh_token).toBe("1//new-refresh");
    expect(updated.access_token).toBe("ya29.new-access");
  });

  test("refresh_token 없는 tokens 이벤트는 콜백 미호출", () => {
    const client = createOAuth2Client(testConfig);
    const tokens: GoogleTokens = { refresh_token: "1//original" };
    const callback = mock((_updated: GoogleTokens) => {});

    configureClient(client, tokens, callback);

    // access_token만 갱신 (refresh_token 없음) → 디스크 저장 불필요
    client.emit("tokens", {
      access_token: "ya29.refreshed",
      expiry_date: 9999999999999,
    });

    expect(callback).not.toHaveBeenCalled();
  });

  test("refresh_token 회전 시 scope 보존", () => {
    const client = createOAuth2Client(testConfig);
    const tokens: GoogleTokens = {
      refresh_token: "1//old-refresh",
      scope: "openid email profile https://www.googleapis.com/auth/gmail.modify",
    };
    const callback = mock((_updated: GoogleTokens) => {});

    configureClient(client, tokens, callback);

    client.emit("tokens", {
      refresh_token: "1//new-refresh",
      access_token: "ya29.new",
      expiry_date: 9999999999999,
    });

    expect(callback).toHaveBeenCalledTimes(1);
    const updated = callback.mock.calls[0]![0];
    expect(updated.refresh_token).toBe("1//new-refresh");
    expect(updated.scope).toBe("openid email profile https://www.googleapis.com/auth/gmail.modify");
  });
});

describe("exchangeCode", () => {
  test("인가 코드 → 토큰 교환 성공", async () => {
    const client = createOAuth2Client(testConfig);
    // getToken mock
    client.getToken = mock(async () => ({
      tokens: {
        access_token: "ya29.access",
        refresh_token: "1//refresh",
        expiry_date: 9999999999999,
        token_type: "Bearer",
        scope: "https://www.googleapis.com/auth/gmail.modify",
      },
      res: null,
    })) as typeof client.getToken;

    const result = await exchangeCode(client, "auth-code-123");

    expect(result.refresh_token).toBe("1//refresh");
    expect(result.access_token).toBe("ya29.access");
    expect(result.token_type).toBe("Bearer");
  });

  test("refresh_token 미포함 시 에러", async () => {
    const client = createOAuth2Client(testConfig);
    client.getToken = mock(async () => ({
      tokens: {
        access_token: "ya29.access",
        // refresh_token 없음
      },
      res: null,
    })) as typeof client.getToken;

    expect(exchangeCode(client, "auth-code-123")).rejects.toThrow(
      "No refresh_token received",
    );
  });

  test("null 값은 undefined로 변환", async () => {
    const client = createOAuth2Client(testConfig);
    client.getToken = mock(async () => ({
      tokens: {
        access_token: null,
        refresh_token: "1//refresh",
        expiry_date: null,
        token_type: null,
        scope: null,
      },
      res: null,
    })) as unknown as typeof client.getToken;

    const result = await exchangeCode(client, "code");
    expect(result.access_token).toBeUndefined();
    expect(result.expiry_date).toBeUndefined();
    expect(result.refresh_token).toBe("1//refresh");
  });
});

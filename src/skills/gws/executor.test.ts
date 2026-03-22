import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { randomBytes } from "node:crypto";
import { createGwsExecutorFactory } from "./executor.js";
import { AesGcmEncryption } from "./encryption.js";
import { JsonFileTokenStore, type GoogleTokens } from "./token-store.js";
import type { GoogleAuthConfig } from "./google-auth.js";
import { createTestDir } from "../../test-utils/tmpdir.js";

/** 테스트용 32바이트 키 (hex) */
const TEST_KEY = randomBytes(32).toString("hex");
const td = createTestDir("executor");

const testAuthConfig: GoogleAuthConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  redirectUri: "https://example.com/callback",
};

const sampleTokens: GoogleTokens = {
  refresh_token: "1//test-refresh-token",
  access_token: "ya29.test-access",
};

describe("createGwsExecutorFactory", () => {
  let tokenStore: JsonFileTokenStore;
  let factory: ReturnType<typeof createGwsExecutorFactory>;

  beforeEach(() => {
    const dataDir = td.path();
    const encryption = new AesGcmEncryption(TEST_KEY);
    tokenStore = new JsonFileTokenStore(dataDir, encryption);
    factory = createGwsExecutorFactory(tokenStore, testAuthConfig);
  });

  afterEach(async () => {
    factory.invalidate();
    await td.cleanup();
  });

  test("토큰 없는 워크스페이스 → null 반환", async () => {
    const result = await factory.getExecutors("ws-no-tokens");
    expect(result).toBeNull();
  });

  test("토큰 있는 워크스페이스 → 15개 executor Map 반환", async () => {
    await tokenStore.save("ws-1", sampleTokens);
    const result = await factory.getExecutors("ws-1");

    expect(result).not.toBeNull();
    expect(result!.size).toBe(15);
    expect(result!.has("gmail_list")).toBe(true);
    expect(result!.has("gmail_send")).toBe(true);
    expect(result!.has("calendar_create")).toBe(true);
    expect(result!.has("drive_search")).toBe(true);
  });

  test("캐시 히트: 동일 workspaceId → 같은 참조 반환", async () => {
    await tokenStore.save("ws-1", sampleTokens);
    const first = await factory.getExecutors("ws-1");
    const second = await factory.getExecutors("ws-1");

    expect(second).toBe(first);
  });

  test("워크스페이스별 격리: 다른 workspaceId → 다른 Map", async () => {
    await tokenStore.save("ws-1", sampleTokens);
    await tokenStore.save("ws-2", { refresh_token: "1//other" });
    const map1 = await factory.getExecutors("ws-1");
    const map2 = await factory.getExecutors("ws-2");

    expect(map1).not.toBe(map2);
  });

  test("캐시 무효화 후 새 Map 생성", async () => {
    await tokenStore.save("ws-1", sampleTokens);
    const first = await factory.getExecutors("ws-1");
    factory.invalidate("ws-1");
    const second = await factory.getExecutors("ws-1");

    expect(second).not.toBe(first);
    expect(second!.size).toBe(15);
  });

  test("전체 캐시 클리어", async () => {
    await tokenStore.save("ws-1", sampleTokens);
    await tokenStore.save("ws-2", sampleTokens);
    await factory.getExecutors("ws-1");
    await factory.getExecutors("ws-2");

    factory.invalidate();

    const fresh = await factory.getExecutors("ws-1");
    expect(fresh).not.toBeNull();
  });

  test("팩토리 간 캐시 격리", async () => {
    const dataDir2 = td.path();
    const encryption2 = new AesGcmEncryption(TEST_KEY);
    const tokenStore2 = new JsonFileTokenStore(dataDir2, encryption2);
    const factory2 = createGwsExecutorFactory(tokenStore2, testAuthConfig);

    await tokenStore.save("ws-1", sampleTokens);
    await tokenStore2.save("ws-1", sampleTokens);

    const from1 = await factory.getExecutors("ws-1");
    const from2 = await factory2.getExecutors("ws-1");

    // 서로 다른 팩토리의 캐시는 격리
    expect(from1).not.toBe(from2);

    // 한쪽 무효화가 다른 쪽에 영향 없음
    factory.invalidate("ws-1");
    const still = await factory2.getExecutors("ws-1");
    expect(still).toBe(from2);

    factory2.invalidate();
  });
});

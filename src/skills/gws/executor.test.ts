import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { randomBytes } from "node:crypto";
import { createGwsExecutorFactory, invalidateGwsExecutors } from "./executor.js";
import { AesGcmEncryption } from "./encryption.js";
import { JsonFileTokenStore, type GoogleTokens } from "./token-store.js";
import type { GoogleAuthConfig } from "./google-auth.js";
import { createTestDir } from "../../test-utils/tmpdir.js";

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

afterEach(async () => {
  invalidateGwsExecutors();
  await td.cleanup();
});

describe("createGwsExecutorFactory", () => {
  let tokenStore: JsonFileTokenStore;
  let getGwsExecutors: ReturnType<typeof createGwsExecutorFactory>;

  beforeEach(() => {
    const dataDir = td.path();
    const encryption = new AesGcmEncryption(TEST_KEY);
    tokenStore = new JsonFileTokenStore(dataDir, encryption);
    getGwsExecutors = createGwsExecutorFactory(tokenStore, testAuthConfig);
  });

  test("토큰 없는 워크스페이스 → null 반환", async () => {
    const result = await getGwsExecutors("ws-no-tokens");
    expect(result).toBeNull();
  });

  test("토큰 있는 워크스페이스 → 15개 executor Map 반환", async () => {
    await tokenStore.save("ws-1", sampleTokens);
    const result = await getGwsExecutors("ws-1");

    expect(result).not.toBeNull();
    expect(result!.size).toBe(15);
    expect(result!.has("gmail_list")).toBe(true);
    expect(result!.has("gmail_send")).toBe(true);
    expect(result!.has("calendar_create")).toBe(true);
    expect(result!.has("drive_search")).toBe(true);
  });

  test("캐시 히트: 동일 workspaceId → 같은 참조 반환", async () => {
    await tokenStore.save("ws-1", sampleTokens);
    const first = await getGwsExecutors("ws-1");
    const second = await getGwsExecutors("ws-1");

    expect(second).toBe(first);
  });

  test("워크스페이스별 격리: 다른 workspaceId → 다른 Map", async () => {
    await tokenStore.save("ws-1", sampleTokens);
    await tokenStore.save("ws-2", { refresh_token: "1//other" });
    const map1 = await getGwsExecutors("ws-1");
    const map2 = await getGwsExecutors("ws-2");

    expect(map1).not.toBe(map2);
  });
});

describe("invalidateGwsExecutors", () => {
  test("캐시 무효화 후 새 Map 생성", async () => {
    const dataDir = td.path();
    const encryption = new AesGcmEncryption(TEST_KEY);
    const tokenStore = new JsonFileTokenStore(dataDir, encryption);
    const getGwsExecutors = createGwsExecutorFactory(tokenStore, testAuthConfig);

    await tokenStore.save("ws-1", sampleTokens);
    const first = await getGwsExecutors("ws-1");
    invalidateGwsExecutors("ws-1");
    const second = await getGwsExecutors("ws-1");

    expect(second).not.toBe(first);
    expect(second!.size).toBe(15);
  });

  test("전체 캐시 클리어", async () => {
    const dataDir = td.path();
    const encryption = new AesGcmEncryption(TEST_KEY);
    const tokenStore = new JsonFileTokenStore(dataDir, encryption);
    const getGwsExecutors = createGwsExecutorFactory(tokenStore, testAuthConfig);

    await tokenStore.save("ws-1", sampleTokens);
    await tokenStore.save("ws-2", sampleTokens);
    await getGwsExecutors("ws-1");
    await getGwsExecutors("ws-2");

    invalidateGwsExecutors();

    // 캐시 클리어 후 재생성 확인
    const fresh = await getGwsExecutors("ws-1");
    expect(fresh).not.toBeNull();
  });
});

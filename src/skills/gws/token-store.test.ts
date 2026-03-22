import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { AesGcmEncryption } from "./encryption.js";
import { JsonFileTokenStore, type GoogleTokens } from "./token-store.js";
import { createTestDir } from "../../test-utils/tmpdir.js";

const TEST_KEY = randomBytes(32).toString("hex");
const td = createTestDir("token-store");

describe("JsonFileTokenStore", () => {
  let store: JsonFileTokenStore;
  let dataDir: string;

  beforeEach(() => {
    dataDir = td.path();
    const encryption = new AesGcmEncryption(TEST_KEY);
    store = new JsonFileTokenStore(dataDir, encryption);
  });

  afterEach(async () => {
    await td.cleanup();
  });

  const sampleTokens: GoogleTokens = {
    access_token: "ya29.test-access-token",
    refresh_token: "1//test-refresh-token",
    expiry_date: Date.now() + 3600_000,
    token_type: "Bearer",
    scope: "https://www.googleapis.com/auth/gmail.modify",
  };

  describe("save + load", () => {
    test("토큰 저장 후 로드", async () => {
      await store.save("ws-1", sampleTokens);
      const loaded = await store.load("ws-1");
      expect(loaded).toEqual(sampleTokens);
    });

    test("워크스페이스별 격리", async () => {
      const tokens2: GoogleTokens = {
        refresh_token: "1//other-token",
      };
      await store.save("ws-1", sampleTokens);
      await store.save("ws-2", tokens2);

      expect(await store.load("ws-1")).toEqual(sampleTokens);
      expect(await store.load("ws-2")).toEqual(tokens2);
    });

    test("토큰 덮어쓰기", async () => {
      await store.save("ws-1", sampleTokens);
      const updated: GoogleTokens = {
        refresh_token: "1//updated-token",
      };
      await store.save("ws-1", updated);
      expect(await store.load("ws-1")).toEqual(updated);
    });

    test("파일이 암호화되어 저장됨 (평문 아님)", async () => {
      await store.save("ws-1", sampleTokens);
      const filePath = join(dataDir, "ws-1", "google-tokens.enc");
      const raw = await Bun.file(filePath).text();
      // 평문 JSON이 아닌지 확인
      expect(() => JSON.parse(raw)).toThrow();
      // base64 형식인지 확인
      expect(raw).toMatch(/^[A-Za-z0-9+/]+=*$/);
    });

    test("refresh_token만 있는 최소 토큰", async () => {
      const minimal: GoogleTokens = { refresh_token: "1//minimal" };
      await store.save("ws-1", minimal);
      expect(await store.load("ws-1")).toEqual(minimal);
    });
  });

  describe("load", () => {
    test("존재하지 않는 워크스페이스 → null", async () => {
      expect(await store.load("nonexistent")).toBeNull();
    });

    test("다른 키로 초기화된 store에서 복호화 실패 시 null + 에러 로그", async () => {
      await store.save("ws-1", sampleTokens);

      const otherKey = randomBytes(32).toString("hex");
      const otherStore = new JsonFileTokenStore(
        dataDir,
        new AesGcmEncryption(otherKey),
      );

      expect(await otherStore.load("ws-1")).toBeNull();
    });
  });

  describe("delete", () => {
    test("토큰 삭제 후 load → null", async () => {
      await store.save("ws-1", sampleTokens);
      await store.delete("ws-1");
      expect(await store.load("ws-1")).toBeNull();
    });

    test("존재하지 않는 토큰 삭제 시 에러 없음", async () => {
      await expect(store.delete("nonexistent")).resolves.toBeUndefined();
    });

    test("삭제 후 디렉터리는 유지 (다른 데이터 보호)", async () => {
      await store.save("ws-1", sampleTokens);
      await store.delete("ws-1");
      const entries = await readdir(join(dataDir, "ws-1"));
      // 토큰 파일은 삭제, 디렉터리는 유지
      expect(entries).not.toContain("google-tokens.enc");
    });
  });
});

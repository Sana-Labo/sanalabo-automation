import { describe, test, expect } from "bun:test";
import { AesGcmEncryption, VaultTransitEncryption } from "./encryption.js";
import { randomBytes } from "node:crypto";

/** 테스트용 32바이트 키 (hex) */
const TEST_KEY = randomBytes(32).toString("hex");

describe("VaultTransitEncryption", () => {
  /** base64 decode → string */
  const b64decode = (s: string): string => Buffer.from(s, "base64").toString("utf8");
  /** string → base64 */
  const b64encode = (s: string): string => Buffer.from(s, "utf8").toString("base64");

  /** Vault Transit API를 흉내내는 in-memory fetch mock */
  function createFakeFetch(opts: { agentUrl: string; keyName: string }): {
    fetch: typeof fetch;
    calls: Array<{ url: string; body: unknown }>;
  } {
    const calls: Array<{ url: string; body: unknown }> = [];
    // ciphertext → plaintext 대응표 (deterministic round-trip)
    let counter = 0;
    const store = new Map<string, string>();
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const body = init?.body ? JSON.parse(init.body as string) : {};
      calls.push({ url, body });
      const encryptUrl = `${opts.agentUrl}/v1/transit/encrypt/${opts.keyName}`;
      const decryptUrl = `${opts.agentUrl}/v1/transit/decrypt/${opts.keyName}`;
      if (url === encryptUrl) {
        const plaintext = b64decode(body.plaintext);
        counter += 1;
        const ciphertext = `vault:v1:fakeCiphertext${counter}`;
        store.set(ciphertext, plaintext);
        return new Response(JSON.stringify({ data: { ciphertext } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === decryptUrl) {
        const plaintext = store.get(body.ciphertext);
        if (plaintext === undefined) {
          return new Response(JSON.stringify({ errors: ["invalid ciphertext"] }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({ data: { plaintext: b64encode(plaintext) } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    return { fetch: fakeFetch, calls };
  }

  const agentUrl = "http://vault-agent:8100";
  const keyName = "tokens";

  test("encrypt: POST /v1/transit/encrypt/<key> 호출 + base64 평문", async () => {
    const { fetch: f, calls } = createFakeFetch({ agentUrl, keyName });
    const enc = new VaultTransitEncryption({ agentUrl, keyName, fetch: f });
    const ciphertext = await enc.encrypt("hello");
    expect(ciphertext).toMatch(/^vault:v1:/);
    expect(calls[0]?.url).toBe(`${agentUrl}/v1/transit/encrypt/${keyName}`);
    expect((calls[0]?.body as { plaintext: string }).plaintext).toBe(b64encode("hello"));
  });

  test("encrypt/decrypt 라운드트립", async () => {
    const { fetch: f } = createFakeFetch({ agentUrl, keyName });
    const enc = new VaultTransitEncryption({ agentUrl, keyName, fetch: f });
    const plaintext = '{"refresh_token":"1//abc","access_token":"ya29.xyz"}';
    const ciphertext = await enc.encrypt(plaintext);
    expect(await enc.decrypt(ciphertext)).toBe(plaintext);
  });

  test("한국어/유니코드 라운드트립", async () => {
    const { fetch: f } = createFakeFetch({ agentUrl, keyName });
    const enc = new VaultTransitEncryption({ agentUrl, keyName, fetch: f });
    const plaintext = "토큰 데이터 🔐 인증 완료";
    const ciphertext = await enc.encrypt(plaintext);
    expect(await enc.decrypt(ciphertext)).toBe(plaintext);
  });

  test("빈 문자열 라운드트립", async () => {
    const { fetch: f } = createFakeFetch({ agentUrl, keyName });
    const enc = new VaultTransitEncryption({ agentUrl, keyName, fetch: f });
    const ciphertext = await enc.encrypt("");
    expect(await enc.decrypt(ciphertext)).toBe("");
  });

  test("keyName 기본값은 'tokens'", async () => {
    const { fetch: f, calls } = createFakeFetch({ agentUrl, keyName: "tokens" });
    const enc = new VaultTransitEncryption({ agentUrl, fetch: f });
    await enc.encrypt("x");
    expect(calls[0]?.url).toBe(`${agentUrl}/v1/transit/encrypt/tokens`);
  });

  test("agentUrl 말미 슬래시 허용", async () => {
    const { fetch: f, calls } = createFakeFetch({ agentUrl, keyName });
    const enc = new VaultTransitEncryption({
      agentUrl: `${agentUrl}/`,
      keyName,
      fetch: f,
    });
    await enc.encrypt("x");
    expect(calls[0]?.url).toBe(`${agentUrl}/v1/transit/encrypt/${keyName}`);
  });

  test("HTTP 에러 응답 시 예외", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ errors: ["permission denied"] }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const enc = new VaultTransitEncryption({ agentUrl, keyName, fetch: fakeFetch });
    expect(enc.encrypt("x")).rejects.toThrow(/403/);
  });

  test("네트워크 예외 전파", async () => {
    const fakeFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const enc = new VaultTransitEncryption({ agentUrl, keyName, fetch: fakeFetch });
    expect(enc.encrypt("x")).rejects.toThrow("ECONNREFUSED");
  });

  test("응답에 data.ciphertext 누락 시 예외", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const enc = new VaultTransitEncryption({ agentUrl, keyName, fetch: fakeFetch });
    expect(enc.encrypt("x")).rejects.toThrow();
  });
});

describe("AesGcmEncryption", () => {
  test("생성자: 32바이트(64 hex) 키 수용", () => {
    expect(() => new AesGcmEncryption(TEST_KEY)).not.toThrow();
  });

  test("생성자: 길이가 다른 키는 거부", () => {
    expect(() => new AesGcmEncryption("0".repeat(32))).toThrow(
      "TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex characters)",
    );
  });

  test("생성자: 빈 키 거부", () => {
    expect(() => new AesGcmEncryption("")).toThrow();
  });

  test("encrypt/decrypt 라운드트립", async () => {
    const enc = new AesGcmEncryption(TEST_KEY);
    const plaintext = '{"refresh_token":"1//abc","access_token":"ya29.xyz"}';

    const ciphertext = await enc.encrypt(plaintext);
    const decrypted = await enc.decrypt(ciphertext);

    expect(decrypted).toBe(plaintext);
  });

  test("동일 평문 → 서로 다른 암호문 (랜덤 IV)", async () => {
    const enc = new AesGcmEncryption(TEST_KEY);
    const plaintext = "same plaintext";

    const c1 = await enc.encrypt(plaintext);
    const c2 = await enc.encrypt(plaintext);

    expect(c1).not.toBe(c2);
  });

  test("다른 키로 복호화 시 실패", async () => {
    const enc1 = new AesGcmEncryption(TEST_KEY);
    const enc2 = new AesGcmEncryption(randomBytes(32).toString("hex"));

    const ciphertext = await enc1.encrypt("secret data");

    expect(enc2.decrypt(ciphertext)).rejects.toThrow();
  });

  test("암호문 위변조 시 실패 (인증 태그 무결성)", async () => {
    const enc = new AesGcmEncryption(TEST_KEY);
    const ciphertext = await enc.encrypt("integrity check");

    // 암호문의 마지막 바이트 변조
    const buf = Buffer.from(ciphertext, "base64");
    buf[buf.length - 1]! ^= 0xff;
    const tampered = buf.toString("base64");

    expect(enc.decrypt(tampered)).rejects.toThrow();
  });

  test("빈 문자열 라운드트립", async () => {
    const enc = new AesGcmEncryption(TEST_KEY);
    const ciphertext = await enc.encrypt("");
    expect(await enc.decrypt(ciphertext)).toBe("");
  });

  test("한국어/유니코드 라운드트립", async () => {
    const enc = new AesGcmEncryption(TEST_KEY);
    const plaintext = "토큰 데이터 🔐 인증 완료";
    const ciphertext = await enc.encrypt(plaintext);
    expect(await enc.decrypt(ciphertext)).toBe(plaintext);
  });

  test("대용량 데이터 라운드트립", async () => {
    const enc = new AesGcmEncryption(TEST_KEY);
    const plaintext = "x".repeat(100_000);
    const ciphertext = await enc.encrypt(plaintext);
    expect(await enc.decrypt(ciphertext)).toBe(plaintext);
  });
});

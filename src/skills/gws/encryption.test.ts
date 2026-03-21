import { describe, test, expect } from "bun:test";
import { AesGcmEncryption } from "./encryption.js";
import { randomBytes } from "node:crypto";

/** 테스트용 32바이트 키 (hex) */
const TEST_KEY = randomBytes(32).toString("hex");

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

/**
 * 토큰 암호화 서비스 — AES-256-GCM 구현
 *
 * OAuth refresh_token 등 민감 데이터의 at-rest 암호화 담당.
 * EncryptionService 인터페이스로 추상화하여 향후 KMS 전환 가능.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** 암호화 서비스 인터페이스 (KMS 등으로 교체 가능) */
export interface EncryptionService {
  /** 평문을 암호화하여 base64 문자열로 반환 */
  encrypt(plaintext: string): Promise<string>;
  /** base64 암호문을 복호화하여 평문 반환 */
  decrypt(ciphertext: string): Promise<string>;
}

/**
 * AES-256-GCM 암호화 구현
 *
 * 바이너리 포맷: `base64(iv[12] + authTag[16] + ciphertext)`
 * - IV: 12바이트 (GCM 권장), 매 암호화마다 랜덤 생성
 * - authTag: 16바이트 (무결성 검증)
 */
export class AesGcmEncryption implements EncryptionService {
  private readonly key: Buffer;

  /**
   * @param hexKey - 32바이트(256비트) 키의 hex 표현 (64자)
   * @throws 키 길이가 32바이트가 아닌 경우
   */
  constructor(hexKey: string) {
    this.key = Buffer.from(hexKey, "hex");
    if (this.key.length !== 32) {
      throw new Error(
        "TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex characters)",
      );
    }
  }

  async encrypt(plaintext: string): Promise<string> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    // iv(12) + authTag(16) + ciphertext
    return Buffer.concat([iv, authTag, encrypted]).toString("base64");
  }

  async decrypt(ciphertext: string): Promise<string> {
    const data = Buffer.from(ciphertext, "base64");
    const iv = data.subarray(0, 12);
    const authTag = data.subarray(12, 28);
    const encrypted = data.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(encrypted) + decipher.final("utf8");
  }
}

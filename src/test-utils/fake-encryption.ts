/**
 * 테스트용 가짜 암호화 구현
 *
 * {@link EncryptionService} 인터페이스를 만족하면서, 프로덕션 의존성
 * (Vault HTTP, AES 키 관리 등) 없이 단순한 왕복 암호화를 제공한다.
 *
 * `key`가 다르면 복호화가 실패하도록 키 마커를 평문 앞에 붙인다.
 * "다른 키로는 복호화 불가" 시나리오를 검증하는 테스트에서 사용한다.
 */

import type { EncryptionService } from "../skills/gws/encryption.js";

/** 테스트용 암호화. base64(`${key}::${plaintext}`)를 ciphertext로 사용한다. */
export class FakeEncryption implements EncryptionService {
  private readonly key: string;

  /** @param key - 키 구분용 태그. 기본값 `"default"`. */
  constructor(key: string = "default") {
    this.key = key;
  }

  async encrypt(plaintext: string): Promise<string> {
    return Buffer.from(`${this.key}::${plaintext}`, "utf8").toString("base64");
  }

  async decrypt(ciphertext: string): Promise<string> {
    const decoded = Buffer.from(ciphertext, "base64").toString("utf8");
    const marker = `${this.key}::`;
    if (!decoded.startsWith(marker)) {
      throw new Error("FakeEncryption: key mismatch");
    }
    return decoded.slice(marker.length);
  }
}

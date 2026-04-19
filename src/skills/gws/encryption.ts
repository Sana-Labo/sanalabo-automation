/**
 * 토큰 암호화 서비스
 *
 * OAuth refresh_token 등 민감 데이터의 at-rest 암호화 담당.
 * 프로덕션 구현: {@link VaultTransitEncryption} — Vault Transit 엔진 경유.
 * 테스트용 구현은 `src/test-utils/fake-encryption.ts`의 `FakeEncryption` 참조.
 */

/** 암호화 서비스 인터페이스 (KMS 등으로 교체 가능) */
export interface EncryptionService {
  /** 평문을 암호화하여 문자열로 반환 */
  encrypt(plaintext: string): Promise<string>;
  /** 암호문을 복호화하여 평문 반환 */
  decrypt(ciphertext: string): Promise<string>;
}

/** {@link VaultTransitEncryption} 생성자 옵션 */
export interface VaultTransitEncryptionOptions {
  /**
   * vault-agent proxy listener base URL (예: `http://vault-agent:8100`).
   * 앱은 자체 Vault 토큰 없이 agent가 auto-auth로 주입한 토큰을 경유한다.
   */
  agentUrl: string;
  /** Transit key 이름. 기본값 `"tokens"`. */
  keyName?: string;
  /** DI용 fetch (테스트에서 mock). 기본값 전역 `fetch`. */
  fetch?: typeof fetch;
}

/**
 * Vault Transit 암호화 구현
 *
 * 평문/암호문을 앱이 직접 처리하지 않고 Vault Transit 엔진에 위임한다.
 * vault-agent sidecar가 AppRole auto-auth로 Vault 토큰을 관리하며,
 * 앱은 agent의 API proxy listener로 평문 HTTP 요청만 보낸다.
 *
 * - `encrypt`: `POST /v1/transit/encrypt/<keyName>` — 평문 base64 전송,
 *   응답의 `data.ciphertext`(예: `vault:v1:...`)를 그대로 반환
 * - `decrypt`: `POST /v1/transit/decrypt/<keyName>` — ciphertext 전송,
 *   응답의 `data.plaintext`(base64)를 UTF-8로 디코드하여 반환
 *
 * 참고: https://developer.hashicorp.com/vault/api-docs/secret/transit
 */
export class VaultTransitEncryption implements EncryptionService {
  private readonly agentUrl: string;
  private readonly keyName: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: VaultTransitEncryptionOptions) {
    this.agentUrl = options.agentUrl.replace(/\/+$/, "");
    this.keyName = options.keyName ?? "tokens";
    this.fetchImpl = options.fetch ?? fetch;
  }

  async encrypt(plaintext: string): Promise<string> {
    const payload = { plaintext: Buffer.from(plaintext, "utf8").toString("base64") };
    const data = await this.request(`/v1/transit/encrypt/${this.keyName}`, payload);
    const ciphertext = data?.data?.ciphertext;
    if (typeof ciphertext !== "string" || ciphertext.length === 0) {
      throw new Error("Vault Transit encrypt response missing data.ciphertext");
    }
    return ciphertext;
  }

  async decrypt(ciphertext: string): Promise<string> {
    const data = await this.request(`/v1/transit/decrypt/${this.keyName}`, { ciphertext });
    const plaintextB64 = data?.data?.plaintext;
    if (typeof plaintextB64 !== "string") {
      throw new Error("Vault Transit decrypt response missing data.plaintext");
    }
    return Buffer.from(plaintextB64, "base64").toString("utf8");
  }

  private async request(
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ data?: { ciphertext?: string; plaintext?: string } }> {
    const res = await this.fetchImpl(`${this.agentUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `Vault Transit request failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`,
      );
    }
    return (await res.json()) as { data?: { ciphertext?: string; plaintext?: string } };
  }
}

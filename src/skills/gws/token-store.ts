/**
 * Google OAuth 토큰 저장소
 *
 * 워크스페이스별 refresh_token을 암호화하여 파일에 저장.
 * TokenStore 인터페이스로 추상화 — 향후 DB 전환 시 구현체만 교체.
 */

import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { EncryptionService } from "./encryption.js";
import { createLogger } from "../../utils/logger.js";
import { toErrorMessage } from "../../utils/error.js";

/** Google OAuth 토큰 */
export interface GoogleTokens {
  access_token?: string;
  /** 필수 — 자동 갱신의 핵심 */
  refresh_token: string;
  expiry_date?: number;
  token_type?: string;
  scope?: string;
}

/** 토큰 저장소 인터페이스 */
export interface TokenStore {
  /** 토큰 암호화 저장 */
  save(workspaceId: string, tokens: GoogleTokens): Promise<void>;
  /** 토큰 로드 (복호화). 없거나 복호화 실패 시 null */
  load(workspaceId: string): Promise<GoogleTokens | null>;
  /** 토큰 삭제 */
  delete(workspaceId: string): Promise<void>;
}

/** 토큰 파일명 */
const TOKEN_FILENAME = "google-tokens.enc";

/**
 * JSON 파일 기반 토큰 저장소
 *
 * 저장 경로: `{dataDir}/{workspaceId}/google-tokens.enc`
 * 포맷: AES-256-GCM 암호화된 base64 문자열
 */
export class JsonFileTokenStore implements TokenStore {
  private readonly dataDir: string;
  private readonly encryption: EncryptionService;
  private readonly log = createLogger("token-store");

  /**
   * @param dataDir - 워크스페이스 데이터 루트 디렉터리
   * @param encryption - 암호화 서비스
   */
  constructor(dataDir: string, encryption: EncryptionService) {
    this.dataDir = dataDir;
    this.encryption = encryption;
  }

  private tokenPath(workspaceId: string): string {
    return join(this.dataDir, workspaceId, TOKEN_FILENAME);
  }

  async save(workspaceId: string, tokens: GoogleTokens): Promise<void> {
    const path = this.tokenPath(workspaceId);
    await mkdir(join(this.dataDir, workspaceId), { recursive: true });
    const encrypted = await this.encryption.encrypt(JSON.stringify(tokens));
    await Bun.write(path, encrypted);
    this.log.info("Tokens saved", { workspaceId });
  }

  async load(workspaceId: string): Promise<GoogleTokens | null> {
    const path = this.tokenPath(workspaceId);
    const file = Bun.file(path);
    if (!(await file.exists())) return null;

    try {
      const encrypted = await file.text();
      const decrypted = await this.encryption.decrypt(encrypted);
      return JSON.parse(decrypted) as GoogleTokens;
    } catch (e) {
      this.log.error("Failed to load tokens", {
        workspaceId,
        error: toErrorMessage(e),
      });
      return null;
    }
  }

  async delete(workspaceId: string): Promise<void> {
    const path = this.tokenPath(workspaceId);
    try {
      await unlink(path);
    } catch {
      // 파일이 없으면 무시
    }
    this.log.info("Tokens deleted", { workspaceId });
  }
}

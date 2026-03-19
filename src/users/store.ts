import { config } from "../config.js";
import type { UserRecord } from "../types.js";
import { JsonFileStore } from "../utils/json-file-store.js";

export interface UserStore {
  /** 사용자 레코드 조회 (미등록 시 undefined) */
  get(userId: string): UserRecord | undefined;
  /** 사용자 레코드 저장 (생성 또는 갱신) */
  set(userId: string, record: UserRecord): Promise<void>;
  /** 시스템 관리자 여부 (config 의존 — 향후 auth 도메인으로 이동 예정) */
  isSystemAdmin(userId: string): boolean;
  /** active 상태 사용자 ID 목록 */
  getActiveUsers(): string[];
  getDefaultWorkspaceId(userId: string): string | undefined;
  setDefaultWorkspaceId(userId: string, workspaceId: string): Promise<void>;
}

export class JsonUserStore extends JsonFileStore<UserRecord> implements UserStore {
  constructor(path: string) {
    super(path, "users");
  }

  get(userId: string): UserRecord | undefined {
    return this.data[userId];
  }

  async set(userId: string, record: UserRecord): Promise<void> {
    this.data[userId] = record;
    await this.save();
  }

  isSystemAdmin(userId: string): boolean {
    return config.systemAdminIds.includes(userId);
  }

  getActiveUsers(): string[] {
    return Object.entries(this.data)
      .filter(([, r]) => r.status === "active")
      .map(([id]) => id);
  }

  getDefaultWorkspaceId(userId: string): string | undefined {
    return this.data[userId]?.defaultWorkspaceId;
  }

  async setDefaultWorkspaceId(userId: string, workspaceId: string): Promise<void> {
    const record = this.data[userId];
    if (!record) return;
    record.defaultWorkspaceId = workspaceId;
    await this.save();
  }

  async registerSystemAdmins(): Promise<void> {
    for (const adminId of config.systemAdminIds) {
      const existing = this.data[adminId];
      if (!existing || existing.status !== "active") {
        this.data[adminId] = {
          status: "active",
          invitedBy: "system",
          invitedAt: new Date().toISOString(),
          activatedAt: new Date().toISOString(),
        };
      }
    }
    await this.save();
    this.log.info("System admins registered", { count: config.systemAdminIds.length });
  }
}

export async function createUserStore(): Promise<UserStore> {
  const store = new JsonUserStore(config.userStorePath);
  await store.load();
  await store.registerSystemAdmins();
  return store;
}

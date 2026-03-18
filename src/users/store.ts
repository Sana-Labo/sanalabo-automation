import { config } from "../config.js";
import type { UserRecord } from "../types.js";
import { JsonFileStore } from "../utils/json-file-store.js";

export interface UserStore {
  isSystemAdmin(userId: string): boolean;
  isActive(userId: string): boolean;
  isInvited(userId: string): boolean;
  getActiveUsers(): string[];
  getDefaultWorkspaceId(userId: string): string | undefined;
  setDefaultWorkspaceId(userId: string, workspaceId: string): Promise<void>;
  invite(userId: string, invitedBy: string): Promise<void>;
  activate(userId: string): Promise<void>;
  deactivate(userId: string): Promise<void>;
}

export class JsonUserStore extends JsonFileStore<UserRecord> implements UserStore {
  constructor(path: string) {
    super(path, "users");
  }

  isSystemAdmin(userId: string): boolean {
    return config.systemAdminIds.includes(userId);
  }

  isActive(userId: string): boolean {
    return this.data[userId]?.status === "active";
  }

  isInvited(userId: string): boolean {
    return this.data[userId]?.status === "invited";
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

  async invite(userId: string, invitedBy: string): Promise<void> {
    const existing = this.data[userId];
    if (existing && existing.status === "active") {
      return; // 이미 활성 상태 — 무처리
    }

    this.data[userId] = {
      status: "invited",
      invitedBy,
      invitedAt: new Date().toISOString(),
    };
    await this.save();
    this.log.info("Invited user", { userId, invitedBy });
  }

  async activate(userId: string): Promise<void> {
    const record = this.data[userId];
    if (!record) return;
    if (record.status === "active") return;

    record.status = "active";
    record.activatedAt = new Date().toISOString();
    await this.save();
    this.log.info("Activated user", { userId });
  }

  async deactivate(userId: string): Promise<void> {
    const record = this.data[userId];
    if (!record || record.status !== "active") return;

    record.status = "inactive";
    record.deactivatedAt = new Date().toISOString();
    await this.save();
    this.log.info("Deactivated user", { userId });
  }

  // 일괄 작업 후 호출자가 save()를 호출해야 함
  private ensureSystemAdmin(userId: string): void {
    const existing = this.data[userId];
    if (!existing || existing.status !== "active") {
      this.data[userId] = {
        status: "active",
        invitedBy: "system",
        invitedAt: new Date().toISOString(),
        activatedAt: new Date().toISOString(),
      };
    }
  }

  async registerSystemAdmins(): Promise<void> {
    for (const adminId of config.systemAdminIds) {
      this.ensureSystemAdmin(adminId);
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

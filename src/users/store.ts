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

class JsonUserStore extends JsonFileStore<UserRecord> implements UserStore {
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
      return; // Already active — no-op
    }

    this.data[userId] = {
      status: "invited",
      systemRole: "user",
      invitedBy,
      invitedAt: new Date().toISOString(),
    };
    await this.save();
    console.log(`[users] Invited ${userId} by ${invitedBy}`);
  }

  async activate(userId: string): Promise<void> {
    const record = this.data[userId];
    if (!record) return;
    if (record.status === "active") return;

    record.status = "active";
    record.activatedAt = new Date().toISOString();
    await this.save();
    console.log(`[users] Activated ${userId}`);
  }

  async deactivate(userId: string): Promise<void> {
    const record = this.data[userId];
    if (!record || record.status !== "active") return;

    record.status = "inactive";
    record.deactivatedAt = new Date().toISOString();
    await this.save();
    console.log(`[users] Deactivated ${userId}`);
  }

  // Caller must call save() after batch operations
  private ensureSystemAdmin(userId: string): void {
    const existing = this.data[userId];
    if (!existing || existing.status !== "active") {
      this.data[userId] = {
        status: "active",
        systemRole: "admin",
        invitedBy: "system",
        invitedAt: new Date().toISOString(),
        activatedAt: new Date().toISOString(),
      };
    } else {
      existing.systemRole = "admin";
    }
  }

  async registerSystemAdmins(): Promise<void> {
    for (const adminId of config.systemAdminIds) {
      this.ensureSystemAdmin(adminId);
    }
    await this.save();
    console.log(
      `[users] System admins registered: ${config.systemAdminIds.length} user(s)`,
    );
  }
}

export async function createUserStore(): Promise<UserStore> {
  const store = new JsonUserStore(config.userStorePath);
  await store.load();
  await store.registerSystemAdmins();
  return store;
}

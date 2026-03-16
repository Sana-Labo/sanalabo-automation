import { rename } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "../config.js";
import type { UserRecord } from "../types.js";

export interface UserStore {
  isAdmin(userId: string): boolean;
  isActive(userId: string): boolean;
  isInvited(userId: string): boolean;
  getActiveUsers(): string[];
  invite(userId: string, invitedBy: string): Promise<void>;
  activate(userId: string): Promise<void>;
  deactivate(userId: string): Promise<void>;
}

type StoreData = Record<string, UserRecord>;

class JsonUserStore implements UserStore {
  private data: StoreData = {};
  private readonly path: string;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<void> {
    // Ensure data directory exists
    const dir = dirname(this.path);
    await Bun.write(Bun.file(dir + "/.keep"), "");

    try {
      const file = Bun.file(this.path);
      if (await file.exists()) {
        this.data = (await file.json()) as StoreData;
      }
    } catch (e) {
      console.error("[users] Failed to load store:", e);
      try {
        await rename(this.path, `${this.path}.corrupt.${Date.now()}`);
        console.warn("[users] Corrupted file backed up");
      } catch {
        // Backup failed — file may not exist
      }
      this.data = {};
    }
  }

  private async save(): Promise<void> {
    this.writeLock = this.writeLock.then(async () => {
      const tmp = `${this.path}.tmp.${Date.now()}`;
      await Bun.write(Bun.file(tmp), JSON.stringify(this.data, null, 2) + "\n");
      await rename(tmp, this.path);
    });
    await this.writeLock;
  }

  isAdmin(userId: string): boolean {
    return config.adminUserIds.includes(userId);
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

  async invite(userId: string, invitedBy: string): Promise<void> {
    const existing = this.data[userId];
    if (existing && existing.status === "active") {
      return; // Already active — no-op
    }

    this.data[userId] = {
      status: "invited",
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

  private async ensureAdmin(userId: string): Promise<void> {
    if (!this.data[userId] || this.data[userId]!.status !== "active") {
      this.data[userId] = {
        status: "active",
        invitedBy: "system",
        invitedAt: new Date().toISOString(),
        activatedAt: new Date().toISOString(),
      };
    }
  }

  async registerAdmins(): Promise<void> {
    for (const adminId of config.adminUserIds) {
      await this.ensureAdmin(adminId);
    }
    await this.save();
    console.log(
      `[users] Admins registered: ${config.adminUserIds.length} user(s)`,
    );
  }
}

export async function createUserStore(): Promise<UserStore> {
  const store = new JsonUserStore(config.userStorePath);
  await store.load();
  await store.registerAdmins();
  return store;
}

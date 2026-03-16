import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "../config.js";
import type {
  PendingAction,
  PendingActionStatus,
  PendingActionStore,
} from "../types.js";

type StoreData = Record<string, PendingAction>;

export class JsonPendingActionStore implements PendingActionStore {
  private data: StoreData = {};
  private readonly path: string;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });

    try {
      const file = Bun.file(this.path);
      if (await file.exists()) {
        this.data = (await file.json()) as StoreData;
      }
    } catch (e) {
      console.error("[approvals] Failed to load store:", e);
      try {
        await rename(this.path, `${this.path}.corrupt.${Date.now()}`);
        console.warn("[approvals] Corrupted file backed up");
      } catch {
        // Backup failed — file may not exist
      }
      this.data = {};
    }
  }

  private async save(): Promise<void> {
    const prev = this.writeLock;
    let resolve!: () => void;
    this.writeLock = new Promise<void>((r) => {
      resolve = r;
    });
    await prev;
    try {
      const tmp = `${this.path}.tmp.${crypto.randomUUID()}`;
      await Bun.write(Bun.file(tmp), JSON.stringify(this.data, null, 2) + "\n");
      await rename(tmp, this.path);
    } catch (err) {
      console.error("[approvals] Save failed:", err);
      throw err;
    } finally {
      resolve();
    }
  }

  async create(
    action: Omit<PendingAction, "id" | "status" | "createdAt">,
  ): Promise<PendingAction> {
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const record: PendingAction = {
      ...action,
      id,
      status: "pending",
      createdAt: new Date().toISOString(),
    };

    this.data[id] = record;
    await this.save();
    console.log(`[approvals] Created pending action ${id} (${action.toolName}) for ${action.requesterId}`);
    return record;
  }

  get(actionId: string): PendingAction | undefined {
    return this.data[actionId];
  }

  getByWorkspace(workspaceId: string, status?: PendingActionStatus): PendingAction[] {
    return Object.values(this.data).filter((a) => {
      if (a.workspaceId !== workspaceId) return false;
      if (status && a.status !== status) return false;
      return true;
    });
  }

  async approve(actionId: string, approvedBy: string): Promise<PendingAction> {
    const action = this.data[actionId];
    if (!action) throw new Error(`Pending action not found: ${actionId}`);
    if (action.status !== "pending") {
      throw new Error(`Action ${actionId} is already ${action.status}`);
    }

    action.status = "approved";
    action.resolvedAt = new Date().toISOString();
    action.resolvedBy = approvedBy;
    await this.save();
    console.log(`[approvals] Approved action ${actionId} by ${approvedBy}`);
    return action;
  }

  async reject(actionId: string, rejectedBy: string, reason?: string): Promise<PendingAction> {
    const action = this.data[actionId];
    if (!action) throw new Error(`Pending action not found: ${actionId}`);
    if (action.status !== "pending") {
      throw new Error(`Action ${actionId} is already ${action.status}`);
    }

    action.status = "rejected";
    action.resolvedAt = new Date().toISOString();
    action.resolvedBy = rejectedBy;
    if (reason) action.rejectionReason = reason;
    await this.save();
    console.log(`[approvals] Rejected action ${actionId} by ${rejectedBy}`);
    return action;
  }

  async purgeResolved(days: number): Promise<number> {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    let purged = 0;

    for (const [id, action] of Object.entries(this.data)) {
      if (
        action.status !== "pending" &&
        action.resolvedAt &&
        new Date(action.resolvedAt).getTime() < cutoff
      ) {
        delete this.data[id];
        purged++;
      }
    }

    if (purged > 0) await this.save();
    return purged;
  }

  async expireOlderThan(hours: number): Promise<number> {
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    let expired = 0;

    for (const action of Object.values(this.data)) {
      if (
        action.status === "pending" &&
        new Date(action.createdAt).getTime() < cutoff
      ) {
        action.status = "expired";
        action.resolvedAt = new Date().toISOString();
        expired++;
      }
    }

    if (expired > 0) await this.save();
    return expired;
  }
}

export async function createPendingActionStore(): Promise<PendingActionStore> {
  const store = new JsonPendingActionStore(config.pendingActionStorePath);
  await store.load();
  return store;
}

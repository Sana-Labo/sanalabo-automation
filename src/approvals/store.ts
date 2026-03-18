import { config } from "../config.js";
import type {
  PendingAction,
  PendingActionStatus,
  PendingActionStore,
} from "../types.js";
import { JsonFileStore } from "../utils/json-file-store.js";

export class JsonPendingActionStore extends JsonFileStore<PendingAction> implements PendingActionStore {
  constructor(path: string) {
    super(path, "approvals");
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
    this.log.info("Created pending action", { id, toolName: action.toolName, requesterId: action.requesterId });
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
    this.log.info("Approved action", { actionId, approvedBy });
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
    this.log.info("Rejected action", { actionId, rejectedBy });
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

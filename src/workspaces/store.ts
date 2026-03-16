import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "../config.js";
import type {
  WorkspaceMembership,
  WorkspaceRecord,
  WorkspaceRole,
  WorkspaceStore,
} from "../types.js";

type StoreData = Record<string, WorkspaceRecord>;

export class JsonWorkspaceStore implements WorkspaceStore {
  private data: StoreData = {};
  private readonly path: string;
  private readonly dataDir: string;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(path: string, dataDir: string) {
    this.path = path;
    this.dataDir = dataDir;
  }

  async load(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });

    try {
      const file = Bun.file(this.path);
      if (await file.exists()) {
        this.data = (await file.json()) as StoreData;
      }
    } catch (e) {
      console.error("[workspaces] Failed to load store:", e);
      try {
        await rename(this.path, `${this.path}.corrupt.${Date.now()}`);
        console.warn("[workspaces] Corrupted file backed up");
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
      const tmp = `${this.path}.tmp.${Date.now()}`;
      await Bun.write(Bun.file(tmp), JSON.stringify(this.data, null, 2) + "\n");
      await rename(tmp, this.path);
    } catch (err) {
      console.error("[workspaces] Save failed:", err);
    } finally {
      resolve();
    }
  }

  getAll(): WorkspaceRecord[] {
    return Object.values(this.data);
  }

  get(workspaceId: string): WorkspaceRecord | undefined {
    return this.data[workspaceId];
  }

  getByOwner(ownerId: string): WorkspaceRecord[] {
    return Object.values(this.data).filter((ws) => ws.ownerId === ownerId);
  }

  getByMember(userId: string): WorkspaceRecord[] {
    return Object.values(this.data).filter(
      (ws) => userId in ws.members,
    );
  }

  async create(name: string, ownerId: string): Promise<WorkspaceRecord> {
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const gwsConfigDir = `${this.dataDir}/${id}/gws-config`;

    await mkdir(gwsConfigDir, { recursive: true });

    const membership: WorkspaceMembership = {
      role: "owner",
      joinedAt: new Date().toISOString(),
      invitedBy: "system",
    };

    const record: WorkspaceRecord = {
      id,
      name,
      ownerId,
      gwsConfigDir,
      createdAt: new Date().toISOString(),
      members: { [ownerId]: membership },
    };

    this.data[id] = record;
    await this.save();
    console.log(`[workspaces] Created workspace "${name}" (${id}) for owner ${ownerId}`);
    return record;
  }

  async inviteMember(workspaceId: string, userId: string, invitedBy: string): Promise<void> {
    const ws = this.data[workspaceId];
    if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);
    if (userId in ws.members) return; // Already a member

    ws.members[userId] = {
      role: "member",
      joinedAt: new Date().toISOString(),
      invitedBy,
    };
    await this.save();
    console.log(`[workspaces] Added member ${userId} to workspace ${workspaceId}`);
  }

  async removeMember(workspaceId: string, userId: string): Promise<void> {
    const ws = this.data[workspaceId];
    if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);
    if (userId === ws.ownerId) throw new Error("Cannot remove workspace owner");

    delete ws.members[userId];
    await this.save();
    console.log(`[workspaces] Removed member ${userId} from workspace ${workspaceId}`);
  }

  resolveWorkspace(userId: string, defaultWorkspaceId?: string): WorkspaceRecord | undefined {
    const workspaces = this.getByMember(userId);

    if (workspaces.length === 0) return undefined;
    if (workspaces.length === 1) return workspaces[0];

    // Multiple workspaces — use default if set
    if (defaultWorkspaceId) {
      return workspaces.find((ws) => ws.id === defaultWorkspaceId);
    }

    // No default — caller must prompt for selection
    return undefined;
  }

  getUserRole(workspaceId: string, userId: string): WorkspaceRole | undefined {
    const ws = this.data[workspaceId];
    if (!ws) return undefined;
    return ws.members[userId]?.role;
  }
}

export async function createWorkspaceStore(): Promise<WorkspaceStore> {
  const store = new JsonWorkspaceStore(
    config.workspaceStorePath,
    config.workspaceDataDir,
  );
  await store.load();
  return store;
}

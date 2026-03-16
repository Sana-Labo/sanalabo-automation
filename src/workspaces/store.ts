import { mkdir } from "node:fs/promises";
import { config } from "../config.js";
import type {
  WorkspaceMembership,
  WorkspaceRecord,
  WorkspaceRole,
  WorkspaceStore,
} from "../types.js";
import { JsonFileStore } from "../utils/json-file-store.js";

export class JsonWorkspaceStore extends JsonFileStore<WorkspaceRecord> implements WorkspaceStore {
  private readonly dataDir: string;

  constructor(path: string, dataDir: string) {
    super(path, "workspaces");
    this.dataDir = dataDir;
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
    let id: string;
    do {
      id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    } while (this.data[id]);
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
      gwsAuthenticated: false,
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

  async setGwsAuthenticated(workspaceId: string, authenticated: boolean): Promise<void> {
    const ws = this.data[workspaceId];
    if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);
    ws.gwsAuthenticated = authenticated;
    await this.save();
    console.log(`[workspaces] Set gwsAuthenticated=${authenticated} for workspace ${workspaceId}`);
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

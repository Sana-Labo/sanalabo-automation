import { mkdir } from "node:fs/promises";
import { config } from "../config.js";
import type {
  Role,
  WorkspaceMembership,
  WorkspaceRecord,
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
    this.log.info("Created workspace", { name, id, ownerId });
    return record;
  }

  async inviteMember(workspaceId: string, userId: string, invitedBy: string): Promise<void> {
    const ws = this.data[workspaceId];
    if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);
    if (userId in ws.members) return; // 이미 멤버

    ws.members[userId] = {
      role: "member",
      joinedAt: new Date().toISOString(),
      invitedBy,
    };
    await this.save();
    this.log.info("Added member", { userId, workspaceId });
  }

  async removeMember(workspaceId: string, userId: string): Promise<void> {
    const ws = this.data[workspaceId];
    if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);
    if (userId === ws.ownerId) throw new Error("Cannot remove workspace owner");

    delete ws.members[userId];
    await this.save();
    this.log.info("Removed member", { userId, workspaceId });
  }

  resolveWorkspace(userId: string, defaultWorkspaceId?: string): WorkspaceRecord | undefined {
    const workspaces = this.getByMember(userId);

    if (workspaces.length === 0) return undefined;
    if (workspaces.length === 1) return workspaces[0];

    // 복수 워크스페이스 — 기본값이 설정되어 있으면 사용
    if (defaultWorkspaceId) {
      return workspaces.find((ws) => ws.id === defaultWorkspaceId);
    }

    // 기본값 미설정 — 호출자가 선택을 안내해야 함
    return undefined;
  }

  getUserRole(workspaceId: string, userId: string): Role | undefined {
    const ws = this.data[workspaceId];
    if (!ws) return undefined;
    return ws.members[userId]?.role;
  }

  async setGwsAuthenticated(workspaceId: string, authenticated: boolean): Promise<void> {
    const ws = this.data[workspaceId];
    if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);
    ws.gwsAuthenticated = authenticated;
    await this.save();
    this.log.info("Set gwsAuthenticated", { workspaceId, authenticated });
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

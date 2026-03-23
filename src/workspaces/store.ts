import { mkdir } from "node:fs/promises";
import { config } from "../config.js";
import type { GwsAccount, WorkspaceMembership, WorkspaceRecord, WorkspaceRole } from "../domain/workspace.js";
import type { WorkspaceStore } from "../types.js";
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
      id = crypto.randomUUID();
    } while (this.data[id]);

    // 워크스페이스 데이터 디렉터리 생성 (토큰 저장 등에 사용)
    await mkdir(`${this.dataDir}/${id}`, { recursive: true });

    const membership: WorkspaceMembership = {
      role: "owner",
      joinedAt: new Date().toISOString(),
      invitedBy: "system",
    };

    const record: WorkspaceRecord = {
      id,
      name,
      ownerId,
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

  resolveWorkspace(userId: string, lastWorkspaceId?: string): WorkspaceRecord | undefined {
    const workspaces = this.getByMember(userId);

    if (workspaces.length === 0) return undefined;

    // 명시적 진입 모델: lastWorkspaceId가 설정되어 있고 소속 WS와 매칭될 때만 반환
    if (lastWorkspaceId) {
      return workspaces.find((ws) => ws.id === lastWorkspaceId);
    }

    // lastWorkspaceId 미설정 — 호출자가 진입을 안내해야 함
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
    this.log.info("Set gwsAuthenticated", { workspaceId, authenticated });
  }

  async setGwsAccount(workspaceId: string, account: GwsAccount): Promise<void> {
    const ws = this.data[workspaceId];
    if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);
    ws.gwsAccount = account;
    await this.save();
    this.log.info("Set gwsAccount", { workspaceId, email: account.email });
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

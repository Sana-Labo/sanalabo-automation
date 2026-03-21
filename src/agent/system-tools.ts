/**
 * System Tool — 내부 시스템 관리 도구
 *
 * Skill Tool(외부 시스템)과 Infra Tool(루프 제어)의 사이:
 * - 비동기, deps 접근 (Store I/O)
 * - exitLoop 불가 — 결과를 에이전트에 반환, 사용자 안내 위임
 * - 결정론적 처리 (LLM 판단에 의존하지 않음)
 */
import type Anthropic from "@anthropic-ai/sdk";
import type {
  AgentDependencies,
  InternalToolEntry,
  InternalToolSignal,
  ToolContext,
} from "../types.js";
import { canCreateWorkspace, getMaxOwnedWorkspaces, validateWorkspaceName, type WorkspaceRecord } from "../domain/workspace.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("agent");

// --- 타입 ---

/** 시스템 도구 시그널 — 현재는 공통 규격과 동일 */
export type SystemToolSignal = InternalToolSignal;

/** 시스템 도구 핸들러 (비동기 — Store I/O 수행) */
export type SystemToolHandler = (
  input: Record<string, unknown>,
  context: ToolContext,
  deps: AgentDependencies,
) => Promise<SystemToolSignal>;

/** 시스템 도구 등록 엔트리 */
export type SystemToolEntry = InternalToolEntry<SystemToolHandler>;

// --- 엔트리 ---

const createWorkspace: SystemToolEntry = {
  def: {
    name: "create_workspace",
    strict: true,
    description:
      "Create a new workspace. Admins can specify an owner; regular users always own the workspace themselves. Ownership limits apply per role.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Name of the workspace to create",
        },
        owner_user_id: {
          anyOf: [{ type: "string" }, { type: "null" }],
          description:
            "LINE userId of the owner. If null, the caller becomes the owner. Non-admin callers: this field is ignored.",
        },
      },
      required: ["name", "owner_user_id"],
      additionalProperties: false,
    },
  },
  async handler(input, context, deps) {
    const name = input.name as string;

    // 1. owner 결정: admin이 owner_user_id를 지정하면 대상 사용자, 그 외 자기 자신
    const isAdmin = deps.userStore.isSystemAdmin(context.userId);
    const rawOwner = input.owner_user_id as string | null;
    const delegated = isAdmin && rawOwner;

    // owner_user_id 형식 검증 (LINE userId: U + 32 hex chars)
    if (delegated && !/^U[0-9a-f]{32}$/.test(rawOwner)) {
      return { toolResult: `Error: Invalid LINE userId format: ${rawOwner}` };
    }

    const ownerId = delegated ? rawOwner : context.userId;

    // 2. 이름 검증 (순수 함수)
    const validation = validateWorkspaceName(name);
    if (!validation.valid) {
      return { toolResult: `Error: ${validation.error}` };
    }

    // 3. 소유 제한 검증 (순수 함수 + Store 조회) — owner 기준
    //    admin 위임 시에도 대상 사용자에게 일반 사용자 제한 적용
    const limit = getMaxOwnedWorkspaces(delegated ? false : isAdmin);
    const owned = deps.workspaceStore.getByOwner(ownerId);
    if (!canCreateWorkspace(owned.length, limit)) {
      const msg = delegated
        ? `Error: User ${ownerId} already owns ${owned.length} workspace(s). Maximum: ${limit}.`
        : `Error: You already own ${owned.length} workspace(s). Maximum: ${limit}.`;
      return { toolResult: msg };
    }

    // 4. 워크스페이스 생성 (Store I/O) — validation.name은 트리밍 완료
    const ws = await deps.workspaceStore.create(validation.name, ownerId);
    log.info("Workspace created", { workspaceId: ws.id, ownerId });

    // 5. 기본 워크스페이스 설정 (Store I/O) — owner에게 설정
    await deps.userStore.setDefaultWorkspaceId(ownerId, ws.id);

    return {
      toolResult: JSON.stringify({
        workspaceId: ws.id,
        name: ws.name,
        message: "Workspace created successfully. Google Workspace authentication is required to use GWS features.",
      }),
    };
  },
};

/** Admin용: 워크스페이스를 owner 기준으로 그룹화 */
function groupByOwner(workspaces: WorkspaceRecord[]) {
  const map = new Map<string, Array<{ id: string; name: string; createdAt: string }>>();
  for (const ws of workspaces) {
    const list = map.get(ws.ownerId) ?? [];
    list.push({ id: ws.id, name: ws.name, createdAt: ws.createdAt });
    map.set(ws.ownerId, list);
  }
  return Array.from(map.entries()).map(([ownerId, wsList]) => ({
    ownerId,
    workspaces: wsList,
  }));
}

/** 일반 사용자용: 소유/소속 워크스페이스 분리 */
function splitOwnedAndMember(workspaces: WorkspaceRecord[], userId: string) {
  const owned: Array<{ id: string; name: string; createdAt: string }> = [];
  const member: Array<{ id: string; name: string; joinedAt: string; ownerId: string }> = [];

  for (const ws of workspaces) {
    if (ws.ownerId === userId) {
      owned.push({ id: ws.id, name: ws.name, createdAt: ws.createdAt });
    } else {
      const membership = ws.members[userId];
      member.push({
        id: ws.id,
        name: ws.name,
        joinedAt: membership?.joinedAt ?? ws.createdAt,
        ownerId: ws.ownerId,
      });
    }
  }

  return { owned, member };
}

const listWorkspaces: SystemToolEntry = {
  def: {
    name: "list_workspaces",
    strict: true,
    description:
      "List workspaces. Admins see all workspaces grouped by owner; regular users see their owned and member workspaces.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [] as string[],
      additionalProperties: false,
    },
  },
  async handler(_input, context, deps) {
    const isAdmin = deps.userStore.isSystemAdmin(context.userId);

    if (isAdmin) {
      const all = deps.workspaceStore.getAll();
      return {
        toolResult: JSON.stringify({ workspaces: groupByOwner(all) }),
      };
    }

    const workspaces = deps.workspaceStore.getByMember(context.userId);
    return {
      toolResult: JSON.stringify(splitOwnedAndMember(workspaces, context.userId)),
    };
  },
};

/** 조회자 역할 판별 */
type ViewerRole = "admin" | "owner" | "member";

function determineViewerRole(
  isAdmin: boolean,
  ws: WorkspaceRecord,
  userId: string,
): ViewerRole {
  if (isAdmin) return "admin";
  if (ws.ownerId === userId) return "owner";
  return "member";
}

/** 역할별 워크스페이스 프로젝션 */
function projectWorkspace(ws: WorkspaceRecord, viewerRole: ViewerRole) {
  const members = Object.entries(ws.members).map(([userId, m]) => ({
    userId,
    role: m.role,
    joinedAt: m.joinedAt,
    invitedBy: m.invitedBy,
  }));
  const memberCount = Object.keys(ws.members).length;

  switch (viewerRole) {
    case "admin":
      return { id: ws.id, name: ws.name, ownerId: ws.ownerId, gwsAuthenticated: ws.gwsAuthenticated, createdAt: ws.createdAt, memberCount, members };
    case "owner":
      return { id: ws.id, name: ws.name, gwsAuthenticated: ws.gwsAuthenticated, createdAt: ws.createdAt, memberCount, members };
    case "member":
      return { id: ws.id, name: ws.name, ownerId: ws.ownerId, createdAt: ws.createdAt, memberCount, members };
  }
}

const getWorkspaceInfo: SystemToolEntry = {
  def: {
    name: "get_workspace_info",
    strict: true,
    description:
      "Get detailed workspace information. Admins can view any workspace; owners can view their own; members can view workspaces they belong to.",
    input_schema: {
      type: "object" as const,
      properties: {
        workspace_id: {
          anyOf: [{ type: "string" }, { type: "null" }],
          description:
            "Workspace ID to query. If null, uses the current workspace context.",
        },
      },
      required: ["workspace_id"],
      additionalProperties: false,
    },
  },
  async handler(input, context, deps) {
    const wsId = (input.workspace_id as string | null) ?? context.workspaceId;
    if (!wsId) {
      return {
        toolResult: "Error: No workspace specified and no current workspace context.",
      };
    }

    const ws = deps.workspaceStore.get(wsId);
    if (!ws) {
      return { toolResult: `Error: Workspace not found: ${wsId}` };
    }

    // 접근 제어: admin=any, owner=own, member=member-of
    const isAdmin = deps.userStore.isSystemAdmin(context.userId);
    const isOwner = ws.ownerId === context.userId;
    const isMember = ws.members[context.userId] !== undefined;
    if (!isAdmin && !isOwner && !isMember) {
      return { toolResult: "Error: You do not have access to this workspace." };
    }

    const viewerRole = determineViewerRole(isAdmin, ws, context.userId);
    return { toolResult: JSON.stringify(projectWorkspace(ws, viewerRole)) };
  },
};

// --- 레지스트리 ---

const entries: SystemToolEntry[] = [createWorkspace, listWorkspaces, getWorkspaceInfo];

/** 이름 키 Map (O(1) lookup) */
export const systemTools: ReadonlyMap<string, SystemToolEntry> = new Map(
  entries.map((e) => [e.def.name, e]),
);

/** Claude에 보낼 도구 정의 배열 */
export const systemToolDefs: readonly Anthropic.Tool[] = entries.map((e) => e.def);

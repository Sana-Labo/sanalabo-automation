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
import { canCreateWorkspace, validateWorkspaceName, type WorkspaceRecord } from "../domain/workspace.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("agent");

/** 사용자당 워크스페이스 소유 제한 */
const MAX_OWNED_WORKSPACES = 1;

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
      "Create a new workspace for the user. The user can have at most one workspace.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Name of the workspace to create",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  async handler(input, context, deps) {
    const name = input.name as string;

    // 1. 이름 검증 (순수 함수)
    const validation = validateWorkspaceName(name);
    if (!validation.valid) {
      return { toolResult: `Error: ${validation.error}` };
    }

    // 2. 소유 제한 검증 (순수 함수 + Store 조회)
    const owned = deps.workspaceStore.getByOwner(context.userId);
    if (!canCreateWorkspace(owned.length, MAX_OWNED_WORKSPACES)) {
      return {
        toolResult: "Error: You already own a workspace. Each user can own at most one workspace.",
      };
    }

    // 3. 워크스페이스 생성 (Store I/O) — validation.name은 트리밍 완료
    const ws = await deps.workspaceStore.create(validation.name, context.userId);
    log.info("Workspace created", { workspaceId: ws.id, ownerId: context.userId });

    // 4. 기본 워크스페이스 설정 (Store I/O)
    await deps.userStore.setDefaultWorkspaceId(context.userId, ws.id);

    return {
      toolResult: JSON.stringify({
        workspaceId: ws.id,
        name: ws.name,
        message: "Workspace created successfully. Google Workspace authentication is required to use GWS features.",
      }),
    };
  },
};

/** WorkspaceRecord → 요약 객체 (gwsConfigDir 제외) */
function summarizeWorkspace(ws: WorkspaceRecord) {
  return {
    id: ws.id,
    name: ws.name,
    ownerId: ws.ownerId,
    memberCount: Object.keys(ws.members).length,
  };
}

const listWorkspaces: SystemToolEntry = {
  def: {
    name: "list_workspaces",
    strict: true,
    description:
      "List workspaces. Admins see all workspaces; regular users see only workspaces they own.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [] as string[],
      additionalProperties: false,
    },
  },
  async handler(_input, context, deps) {
    const isAdmin = deps.userStore.isSystemAdmin(context.userId);
    const workspaces = isAdmin
      ? deps.workspaceStore.getAll()
      : deps.workspaceStore.getByOwner(context.userId);

    return {
      toolResult: JSON.stringify({
        workspaces: workspaces.map(summarizeWorkspace),
      }),
    };
  },
};

/** WorkspaceRecord → 상세 객체 (gwsConfigDir 제외, members 배열화) */
function detailWorkspace(ws: WorkspaceRecord) {
  return {
    id: ws.id,
    name: ws.name,
    ownerId: ws.ownerId,
    gwsAuthenticated: ws.gwsAuthenticated,
    createdAt: ws.createdAt,
    memberCount: Object.keys(ws.members).length,
    members: Object.entries(ws.members).map(([userId, m]) => ({
      userId,
      role: m.role,
      joinedAt: m.joinedAt,
      invitedBy: m.invitedBy,
    })),
  };
}

const getWorkspaceInfo: SystemToolEntry = {
  def: {
    name: "get_workspace_info",
    strict: true,
    description:
      "Get detailed workspace information. Admins can view any workspace; regular users can only view workspaces they own.",
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

    // 접근 제어: admin은 모든 WS, 일반 사용자는 자기 소유만
    const isAdmin = deps.userStore.isSystemAdmin(context.userId);
    if (!isAdmin && ws.ownerId !== context.userId) {
      return { toolResult: "Error: You do not have access to this workspace." };
    }

    return { toolResult: JSON.stringify(detailWorkspace(ws)) };
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

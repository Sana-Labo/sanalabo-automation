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
  Role,
  ToolContext,
} from "../types.js";
import { isActive, isValidLineUserId } from "../domain/user.js";
import { canCreateWorkspace, getMaxOwnedWorkspaces, validateWorkspaceName, type WorkspaceRecord } from "../domain/workspace.js";
import { notifyActionResult } from "../approvals/notify.js";
import { toErrorMessage } from "../utils/error.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("agent");

// --- 타입 ---

/** 시스템 도구 시그널 */
export interface SystemToolSignal extends InternalToolSignal {
  /** enter_workspace 호출 시 진입한 워크스페이스 ID — loop에서 executor 재구성에 사용 */
  enteredWorkspaceId?: string;
}

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

    if (delegated && !isValidLineUserId(rawOwner)) {
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

    // 5. 마지막 워크스페이스 설정 (Store I/O) — owner에게 설정 (자동 진입)
    await deps.userStore.setLastWorkspaceId(ownerId, ws.id);

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
    if (!map.has(ws.ownerId)) map.set(ws.ownerId, []);
    map.get(ws.ownerId)!.push({ id: ws.id, name: ws.name, createdAt: ws.createdAt });
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
function determineViewerRole(
  isAdmin: boolean,
  ws: WorkspaceRecord,
  userId: string,
): Role {
  if (isAdmin) return "admin";
  if (ws.ownerId === userId) return "owner";
  return "member";
}

/** 역할별 워크스페이스 프로젝션 */
function projectWorkspace(ws: WorkspaceRecord, viewerRole: Role) {
  const members = Object.entries(ws.members).map(([userId, m]) => ({
    userId,
    role: m.role,
    joinedAt: m.joinedAt,
    invitedBy: m.invitedBy,
  }));
  const base = {
    id: ws.id,
    name: ws.name,
    createdAt: ws.createdAt,
    memberCount: members.length,
    members,
  };

  switch (viewerRole) {
    case "admin":
      return { ...base, ownerId: ws.ownerId, gwsAuthenticated: ws.gwsAuthenticated };
    case "owner":
      return { ...base, gwsAuthenticated: ws.gwsAuthenticated };
    case "member":
      return { ...base, ownerId: ws.ownerId };
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

// --- enter_workspace ---

const enterWorkspace: SystemToolEntry = {
  def: {
    name: "enter_workspace",
    strict: true,
    description:
      "Enter a workspace to start working. After entering, Google Workspace tools become available. If workspace_id is null, enters the last used workspace.",
    input_schema: {
      type: "object" as const,
      properties: {
        workspace_id: {
          anyOf: [{ type: "string" }, { type: "null" }],
          description:
            "Workspace ID to enter. If null, enters the last used workspace.",
        },
      },
      required: ["workspace_id"],
      additionalProperties: false,
    },
  },
  async handler(input, context, deps) {
    const rawId = input.workspace_id as string | null;
    const wsId = rawId ?? deps.userStore.getLastWorkspaceId(context.userId);

    if (!wsId) {
      return { toolResult: "Error: No workspace specified and no last used workspace." };
    }

    const ws = deps.workspaceStore.get(wsId);
    if (!ws) {
      return { toolResult: `Error: Workspace not found: ${wsId}` };
    }

    const role = deps.workspaceStore.getUserRole(wsId, context.userId);
    if (!role) {
      return { toolResult: "Error: You do not have access to this workspace." };
    }

    await deps.userStore.setLastWorkspaceId(context.userId, wsId);
    log.info("Workspace entered", { userId: context.userId, workspaceId: wsId });

    return {
      enteredWorkspaceId: ws.id,
      toolResult: JSON.stringify({
        workspaceId: ws.id,
        name: ws.name,
        role,
        message: "Workspace entered. GWS tools are now available.",
      }),
    };
  },
};

// --- invite_member ---

const inviteMember: SystemToolEntry = {
  def: {
    name: "invite_member",
    strict: true,
    description:
      "Invite a user to a workspace. Workspace owners and system admins can invite. The invited user is added as a member immediately. Use push_text_message to notify the invited user after calling this tool.",
    input_schema: {
      type: "object" as const,
      properties: {
        user_id: {
          type: "string",
          description: "LINE userId of the user to invite",
        },
        workspace_id: {
          anyOf: [{ type: "string" }, { type: "null" }],
          description:
            "Workspace ID to invite to. If null, uses the current workspace context or the caller's only owned workspace.",
        },
      },
      required: ["user_id", "workspace_id"],
      additionalProperties: false,
    },
  },
  async handler(input, context, deps) {
    const targetId = input.user_id as string;

    // 1. LINE userId 형식 검증
    if (!isValidLineUserId(targetId)) {
      return { toolResult: `Error: Invalid LINE userId format: ${targetId}` };
    }

    // 2. 워크스페이스 해석
    const rawWsId = input.workspace_id as string | null;
    let wsId = rawWsId ?? context.workspaceId;

    // context에도 없으면 소유 WS가 1개인 경우 자동 선택
    if (!wsId) {
      const ownedWs = deps.workspaceStore.getByOwner(context.userId);
      if (ownedWs.length === 0) {
        return { toolResult: "Error: You do not own any workspaces. Create a workspace first." };
      }
      if (ownedWs.length === 1) {
        wsId = ownedWs[0]!.id;
      } else {
        return { toolResult: "Error: You own multiple workspaces. Specify workspace_id." };
      }
    }

    // 3. 워크스페이스 존재 + Owner 권한 검증
    const ws = deps.workspaceStore.get(wsId);
    if (!ws) {
      return { toolResult: `Error: Workspace not found: ${wsId}` };
    }
    if (ws.ownerId !== context.userId && !deps.userStore.isSystemAdmin(context.userId)) {
      return { toolResult: "Error: Only the workspace owner can invite members." };
    }

    // 4. 멤버 추가 (Store I/O)
    await deps.workspaceStore.inviteMember(wsId, targetId, context.userId);
    log.info("Member invited", { workspaceId: wsId, targetId, invitedBy: context.userId });

    return {
      toolResult: JSON.stringify({
        workspaceId: ws.id,
        workspaceName: ws.name,
        invitedUserId: targetId,
        message: `User ${targetId} has been invited to workspace "${ws.name}". Send them a notification via push_text_message.`,
      }),
    };
  },
};

// --- approve_action ---

const approveAction: SystemToolEntry = {
  def: {
    name: "approve_action",
    strict: true,
    description:
      "Approve a pending write action requested by a workspace member. Only the workspace owner can approve. The approved action is executed immediately and the requester is notified.",
    input_schema: {
      type: "object" as const,
      properties: {
        action_id: {
          type: "string",
          description: "ID of the pending action to approve",
        },
      },
      required: ["action_id"],
      additionalProperties: false,
    },
  },
  async handler(input, context, deps) {
    const actionId = input.action_id as string;
    const pendingAction = deps.pendingActionStore.get(actionId);
    if (!pendingAction) {
      return { toolResult: `Error: Pending action not found: ${actionId}` };
    }
    if (pendingAction.status !== "pending") {
      return { toolResult: `Error: Action ${actionId} has already been ${pendingAction.status}.` };
    }

    // Owner 권한 검증 — System Admin이라도 불가 (오너의 Google 데이터)
    const role = deps.workspaceStore.getUserRole(pendingAction.workspaceId, context.userId);
    if (role !== "owner") {
      return { toolResult: "Error: Only the workspace owner can approve actions." };
    }

    // 요청자 멤버십/활성 상태 검증
    const requesterRole = deps.workspaceStore.getUserRole(pendingAction.workspaceId, pendingAction.requesterId);
    if (!requesterRole || !isActive(deps.userStore.get(pendingAction.requesterId))) {
      await deps.pendingActionStore.reject(actionId, context.userId, "Requester no longer a member");
      return { toolResult: "Error: The requesting user is no longer a member. The action has been cancelled." };
    }

    const resolved = await deps.pendingActionStore.approve(actionId, context.userId);

    // GWS 도구 실행 — workspace가 있으면 GWS executor 우선, 없으면 registry 폴백
    const workspace = deps.workspaceStore.get(resolved.workspaceId);
    let executionError: string | undefined;
    const gwsExecs = workspace ? (await deps.getGwsExecutors(workspace.id)) ?? new Map() : new Map();
    const executor = gwsExecs.get(resolved.toolName) ?? deps.registry.executors.get(resolved.toolName);
    if (executor) {
      try {
        await executor(resolved.toolInput);
      } catch (e) {
        executionError = toErrorMessage(e);
        log.error("Execution after approval failed", { actionId, tool: resolved.toolName, error: executionError });
      }
    } else {
      executionError = `Executor not found for tool: ${resolved.toolName}`;
      log.warn("No executor for approved tool", { actionId, tool: resolved.toolName });
    }

    // 요청자에게 알림 (핸들러가 직접 수행)
    await notifyActionResult(resolved, deps.registry, resolved.requesterId, executionError);

    return {
      toolResult: JSON.stringify({
        actionId,
        status: "approved",
        toolName: resolved.toolName,
        executionError: executionError ?? null,
        message: executionError
          ? `Action approved but execution failed: ${executionError}`
          : "Action approved and executed successfully. The requester has been notified.",
      }),
    };
  },
};

// --- reject_action ---

const rejectAction: SystemToolEntry = {
  def: {
    name: "reject_action",
    strict: true,
    description:
      "Reject a pending write action requested by a workspace member. Only the workspace owner can reject. The requester is notified of the rejection.",
    input_schema: {
      type: "object" as const,
      properties: {
        action_id: {
          type: "string",
          description: "ID of the pending action to reject",
        },
        reason: {
          anyOf: [{ type: "string" }, { type: "null" }],
          description: "Optional reason for rejection",
        },
      },
      required: ["action_id", "reason"],
      additionalProperties: false,
    },
  },
  async handler(input, context, deps) {
    const actionId = input.action_id as string;
    const reason = input.reason as string | null;

    const pendingAction = deps.pendingActionStore.get(actionId);
    if (!pendingAction) {
      return { toolResult: `Error: Pending action not found: ${actionId}` };
    }
    if (pendingAction.status !== "pending") {
      return { toolResult: `Error: Action ${actionId} has already been ${pendingAction.status}.` };
    }

    const role = deps.workspaceStore.getUserRole(pendingAction.workspaceId, context.userId);
    if (role !== "owner") {
      return { toolResult: "Error: Only the workspace owner can reject actions." };
    }

    const resolved = await deps.pendingActionStore.reject(actionId, context.userId, reason ?? undefined);

    // 요청자에게 알림 (핸들러가 직접 수행)
    await notifyActionResult(resolved, deps.registry, resolved.requesterId);

    return {
      toolResult: JSON.stringify({
        actionId,
        status: "rejected",
        reason: reason ?? null,
        message: "Action rejected. The requester has been notified.",
      }),
    };
  },
};

/** Postback 직접 호출용 핸들러 export */
export const approveActionHandler = approveAction.handler;
export const rejectActionHandler = rejectAction.handler;

// --- 레지스트리 ---

const entries: SystemToolEntry[] = [
  createWorkspace, listWorkspaces, getWorkspaceInfo,
  enterWorkspace, inviteMember,
  approveAction, rejectAction,
];

/** 이름 키 Map (O(1) lookup) */
export const systemTools: ReadonlyMap<string, SystemToolEntry> = new Map(
  entries.map((e) => [e.def.name, e]),
);

/** Claude에 보낼 도구 정의 배열 */
export const systemToolDefs: readonly Anthropic.Tool[] = entries.map((e) => e.def);

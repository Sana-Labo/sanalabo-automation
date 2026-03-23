/**
 * System Tool — 내부 시스템 관리 도구
 *
 * Skill Tool(외부 시스템)과 Infra Tool(루프 제어)의 사이:
 * - 비동기, deps 접근 (Store I/O)
 * - exitLoop 불가 — 결과를 에이전트에 반환, 사용자 안내 위임
 * - 결정론적 처리 (LLM 판단에 의존하지 않음)
 *
 * Zod 스키마가 단일 출처. strict: true (constrained decoding).
 */
import { z } from "zod";
import {
  LINE_PUSH_FLEX_TOOL,
  LINE_PUSH_TEXT_TOOL,
  type AgentDependencies,
  type Role,
  type ToolContext,
  type ToolRegistry,
} from "../types.js";
import { isActive, isValidLineUserId } from "../domain/user.js";
import { canCreateWorkspace, getMaxOwnedWorkspaces, validateWorkspaceName, type WorkspaceRecord } from "../domain/workspace.js";
import { notifyActionResult } from "../approvals/notify.js";
import { config } from "../config.js";
import { buildConsentUrl } from "../domain/google-oauth.js";
import { createPendingAuth } from "../skills/gws/oauth-state.js";
import { toErrorMessage } from "../utils/error.js";
import { createLogger } from "../utils/logger.js";
import { systemTool, type SystemToolDefinition, type SystemToolSignal } from "./tool-definition.js";

const log = createLogger("agent");

// --- Zod 스키마 ---

const createWorkspaceSchema = z.object({
  name: z.string().describe("Name of the workspace to create"),
  owner_user_id: z
    .string()
    .nullable()
    .describe(
      "LINE userId of the owner. If null, the caller becomes the owner. Non-admin callers: this field is ignored.",
    ),
});

const listWorkspacesSchema = z.object({});

const getWorkspaceInfoSchema = z.object({
  workspace_id: z
    .string()
    .nullable()
    .describe("Workspace ID to query. If null, uses the current workspace context."),
});

const enterWorkspaceSchema = z.object({
  workspace_id: z
    .string()
    .nullable()
    .describe("Workspace ID to enter. If null, enters the last used workspace."),
});

const inviteMemberSchema = z.object({
  user_id: z.string().describe("LINE userId of the user to invite"),
  workspace_id: z
    .string()
    .nullable()
    .describe(
      "Workspace ID to invite to. If null, uses the current workspace context or the caller's only owned workspace.",
    ),
});

const approveActionSchema = z.object({
  action_id: z.string().describe("ID of the pending action to approve"),
});

const rejectActionSchema = z.object({
  action_id: z.string().describe("ID of the pending action to reject"),
  reason: z.string().nullable().describe("Optional reason for rejection"),
});

const authenticateGwsSchema = z.object({
  workspace_id: z
    .string()
    .nullable()
    .describe("Workspace ID to authenticate. If null, uses the current workspace context."),
});

// --- 헬퍼 함수 ---

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

/**
 * OAuth 인증 URL을 Flex Message로 직접 전송 (결정론적, notify.ts 패턴)
 *
 * Claude 경유 시 Flex Message 포맷 누락 위험 → 시스템이 직접 전송.
 */
async function sendOAuthUrl(
  userId: string,
  consentUrl: string,
  workspaceName: string,
  registry: ToolRegistry,
): Promise<void> {
  const flexExecutor = registry.executors.get(LINE_PUSH_FLEX_TOOL);
  if (flexExecutor) {
    await flexExecutor({
      userId,
      message: {
        type: "flex",
        altText: "Google Workspace Authentication",
        contents: {
          type: "bubble",
          header: {
            type: "box",
            layout: "vertical",
            contents: [
              {
                type: "text",
                text: `Google Authentication — ${workspaceName}`,
                weight: "bold",
                size: "md",
              },
            ],
          },
          body: {
            type: "box",
            layout: "vertical",
            spacing: "md",
            contents: [
              {
                type: "text",
                text: "Tap the button below to connect your Google account. This grants access to Gmail, Calendar, and Drive.",
                size: "sm",
                wrap: true,
              },
              {
                type: "text",
                text: "The link expires in 10 minutes.",
                size: "xs",
                color: "#999999",
              },
            ],
          },
          footer: {
            type: "box",
            layout: "vertical",
            contents: [
              {
                type: "button",
                style: "primary",
                action: {
                  type: "uri",
                  label: "Connect Google", // LINE action label: max 20 chars
                  uri: consentUrl,
                },
              },
            ],
          },
        },
      },
    });
    return;
  }

  // Flex 불가 시 텍스트 폴백
  const textExecutor = registry.executors.get(LINE_PUSH_TEXT_TOOL);
  if (textExecutor) {
    await textExecutor({
      userId,
      message: {
        type: "text",
        text: `[Google Authentication — ${workspaceName}]\n\nTap the link below to connect your Google account:\n${consentUrl}\n\nThe link expires in 10 minutes.`,
      },
    });
  }
}

// --- ToolDefinition ---

const createWorkspaceDef = systemTool({
  name: "create_workspace",
  description:
    "Create a new workspace. Admins can specify an owner; regular users always own the workspace themselves. Ownership limits apply per role.",
  inputSchema: createWorkspaceSchema,
  async handler(input, context, deps) {
    // 1. owner 결정: admin이 owner_user_id를 지정하면 대상 사용자, 그 외 자기 자신
    const isAdmin = deps.userStore.isSystemAdmin(context.userId);
    const delegated = isAdmin && input.owner_user_id;

    if (delegated && !isValidLineUserId(input.owner_user_id!)) {
      return { toolResult: `Error: Invalid LINE userId format: ${input.owner_user_id}` };
    }

    const ownerId = delegated ? input.owner_user_id! : context.userId;

    // 2. 이름 검증 (순수 함수)
    const validation = validateWorkspaceName(input.name);
    if (!validation.valid) {
      return { toolResult: `Error: ${validation.error}` };
    }

    // 3. 소유 제한 검증 (순수 함수 + Store 조회) — owner 기준
    const limit = getMaxOwnedWorkspaces(delegated ? false : isAdmin);
    const owned = deps.workspaceStore.getByOwner(ownerId);
    if (!canCreateWorkspace(owned.length, limit)) {
      const msg = delegated
        ? `Error: User ${ownerId} already owns ${owned.length} workspace(s). Maximum: ${limit}.`
        : `Error: You already own ${owned.length} workspace(s). Maximum: ${limit}.`;
      return { toolResult: msg };
    }

    // 4. 워크스페이스 생성 (Store I/O)
    const ws = await deps.workspaceStore.create(validation.name, ownerId);
    log.info("Workspace created", { workspaceId: ws.id, ownerId });

    // 5. 마지막 워크스페이스 설정 (Store I/O) — owner에게 설정 (자동 진입)
    await deps.userStore.setLastWorkspaceId(ownerId, ws.id);

    // 6. 자동 OAuth 트리거: Google 인증 링크 발송 (환경변수 설정 시)
    let authSent = false;
    if (config.googleClientId && config.googleRedirectUri) {
      try {
        const state = createPendingAuth(ownerId, ws.id);
        const consentUrl = buildConsentUrl({
          clientId: config.googleClientId,
          redirectUri: config.googleRedirectUri,
          state,
        });
        await sendOAuthUrl(ownerId, consentUrl, ws.name, deps.registry);
        authSent = true;
      } catch (e) {
        log.error("Auto OAuth trigger failed", { workspaceId: ws.id, error: toErrorMessage(e) });
      }
    }

    return {
      toolResult: JSON.stringify({
        workspaceId: ws.id,
        name: ws.name,
        message: authSent
          ? "Workspace created successfully. A Google authentication link has been sent."
          : "Workspace created successfully. Use authenticate_gws to connect Google Workspace.",
      }),
    };
  },
});

const listWorkspacesDef = systemTool({
  name: "list_workspaces",
  description:
    "List workspaces. Admins see all workspaces grouped by owner; regular users see their owned and member workspaces.",
  inputSchema: listWorkspacesSchema,
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
});

const getWorkspaceInfoDef = systemTool({
  name: "get_workspace_info",
  description:
    "Get detailed workspace information. Admins can view any workspace; owners can view their own; members can view workspaces they belong to.",
  inputSchema: getWorkspaceInfoSchema,
  async handler(input, context, deps) {
    const wsId = input.workspace_id ?? context.workspaceId;
    if (!wsId) {
      return {
        toolResult: "Error: No workspace specified and no current workspace context.",
      };
    }

    const ws = deps.workspaceStore.get(wsId);
    if (!ws) {
      return { toolResult: `Error: Workspace not found: ${wsId}` };
    }

    const isAdmin = deps.userStore.isSystemAdmin(context.userId);
    const isOwner = ws.ownerId === context.userId;
    const isMember = ws.members[context.userId] !== undefined;
    if (!isAdmin && !isOwner && !isMember) {
      return { toolResult: "Error: You do not have access to this workspace." };
    }

    const viewerRole = determineViewerRole(isAdmin, ws, context.userId);
    return { toolResult: JSON.stringify(projectWorkspace(ws, viewerRole)) };
  },
});

const enterWorkspaceDef = systemTool({
  name: "enter_workspace",
  description:
    "Enter a workspace to start working. After entering, Google Workspace tools become available. If workspace_id is null, enters the last used workspace.",
  inputSchema: enterWorkspaceSchema,
  async handler(input, context, deps) {
    const wsId = input.workspace_id ?? deps.userStore.getLastWorkspaceId(context.userId);

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
});

const inviteMemberDef = systemTool({
  name: "invite_member",
  description:
    "Invite a user to a workspace. Workspace owners and system admins can invite. The invited user is added as a member immediately. Use push_text_message to notify the invited user after calling this tool.",
  inputSchema: inviteMemberSchema,
  async handler(input, context, deps) {
    // 1. LINE userId 형식 검증
    if (!isValidLineUserId(input.user_id)) {
      return { toolResult: `Error: Invalid LINE userId format: ${input.user_id}` };
    }

    // 2. 워크스페이스 해석
    let wsId = input.workspace_id ?? context.workspaceId;

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
    await deps.workspaceStore.inviteMember(wsId, input.user_id, context.userId);
    log.info("Member invited", { workspaceId: wsId, targetId: input.user_id, invitedBy: context.userId });

    return {
      toolResult: JSON.stringify({
        workspaceId: ws.id,
        workspaceName: ws.name,
        invitedUserId: input.user_id,
        message: `User ${input.user_id} has been invited to workspace "${ws.name}". Send them a notification via push_text_message.`,
      }),
    };
  },
});

const approveActionDef = systemTool({
  name: "approve_action",
  description:
    "Approve a pending write action requested by a workspace member. Only the workspace owner can approve. The approved action is executed immediately and the requester is notified.",
  inputSchema: approveActionSchema,
  async handler(input, context, deps) {
    const pendingAction = deps.pendingActionStore.get(input.action_id);
    if (!pendingAction) {
      return { toolResult: `Error: Pending action not found: ${input.action_id}` };
    }
    if (pendingAction.status !== "pending") {
      return { toolResult: `Error: Action ${input.action_id} has already been ${pendingAction.status}.` };
    }

    // Owner 権限 검증 — System Admin이라도 불가 (오너의 Google 데이터)
    const role = deps.workspaceStore.getUserRole(pendingAction.workspaceId, context.userId);
    if (role !== "owner") {
      return { toolResult: "Error: Only the workspace owner can approve actions." };
    }

    // 요청자 멤버십/활성 상태 검증
    const requesterRole = deps.workspaceStore.getUserRole(pendingAction.workspaceId, pendingAction.requesterId);
    if (!requesterRole || !isActive(deps.userStore.get(pendingAction.requesterId))) {
      await deps.pendingActionStore.reject(input.action_id, context.userId, "Requester no longer a member");
      return { toolResult: "Error: The requesting user is no longer a member. The action has been cancelled." };
    }

    const resolved = await deps.pendingActionStore.approve(input.action_id, context.userId);

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
        log.error("Execution after approval failed", { actionId: input.action_id, tool: resolved.toolName, error: executionError });
      }
    } else {
      executionError = `Executor not found for tool: ${resolved.toolName}`;
      log.warn("No executor for approved tool", { actionId: input.action_id, tool: resolved.toolName });
    }

    // 요청자에게 알림
    await notifyActionResult(resolved, deps.registry, resolved.requesterId, executionError);

    return {
      toolResult: JSON.stringify({
        actionId: input.action_id,
        status: "approved",
        toolName: resolved.toolName,
        executionError: executionError ?? null,
        message: executionError
          ? `Action approved but execution failed: ${executionError}`
          : "Action approved and executed successfully. The requester has been notified.",
      }),
    };
  },
});

const rejectActionDef = systemTool({
  name: "reject_action",
  description:
    "Reject a pending write action requested by a workspace member. Only the workspace owner can reject. The requester is notified of the rejection.",
  inputSchema: rejectActionSchema,
  async handler(input, context, deps) {
    const pendingAction = deps.pendingActionStore.get(input.action_id);
    if (!pendingAction) {
      return { toolResult: `Error: Pending action not found: ${input.action_id}` };
    }
    if (pendingAction.status !== "pending") {
      return { toolResult: `Error: Action ${input.action_id} has already been ${pendingAction.status}.` };
    }

    const role = deps.workspaceStore.getUserRole(pendingAction.workspaceId, context.userId);
    if (role !== "owner") {
      return { toolResult: "Error: Only the workspace owner can reject actions." };
    }

    const resolved = await deps.pendingActionStore.reject(input.action_id, context.userId, input.reason ?? undefined);

    // 요청자에게 알림
    await notifyActionResult(resolved, deps.registry, resolved.requesterId);

    return {
      toolResult: JSON.stringify({
        actionId: input.action_id,
        status: "rejected",
        reason: input.reason ?? null,
        message: "Action rejected. The requester has been notified.",
      }),
    };
  },
});

const authenticateGwsDef = systemTool({
  name: "authenticate_gws",
  description:
    "Send a Google Workspace authentication link to the workspace owner. Use this when the workspace needs Google authentication or re-authentication.",
  inputSchema: authenticateGwsSchema,
  async handler(input, context, deps) {
    const wsId = input.workspace_id ?? context.workspaceId;
    if (!wsId) {
      return { toolResult: "Error: No workspace specified and no current workspace context." };
    }

    const ws = deps.workspaceStore.get(wsId);
    if (!ws) {
      return { toolResult: `Error: Workspace not found: ${wsId}` };
    }

    // Owner 또는 admin만 인증 가능
    const isAdmin = deps.userStore.isSystemAdmin(context.userId);
    if (ws.ownerId !== context.userId && !isAdmin) {
      return { toolResult: "Error: Only the workspace owner can authenticate Google Workspace." };
    }

    // OAuth 환경변수 검증
    if (!config.googleClientId || !config.googleRedirectUri) {
      return { toolResult: "Error: Google OAuth is not configured on this server." };
    }

    // state 생성 + consent URL 조립
    const state = createPendingAuth(ws.ownerId, ws.id);
    const consentUrl = buildConsentUrl({
      clientId: config.googleClientId,
      redirectUri: config.googleRedirectUri,
      state,
    });

    // Flex Message 직접 전송 (결정론적)
    try {
      await sendOAuthUrl(ws.ownerId, consentUrl, ws.name, deps.registry);
    } catch (e) {
      log.error("Failed to send OAuth URL", { workspaceId: ws.id, error: toErrorMessage(e) });
      return { toolResult: `Error: Failed to send authentication link: ${toErrorMessage(e)}` };
    }

    return {
      toolResult: JSON.stringify({
        workspaceId: ws.id,
        message: "Authentication link has been sent. The owner should open the link in a browser to complete Google authentication.",
      }),
    };
  },
});

/** 모든 System 도구 정의 */
// any 사용 필수: handler의 input이 반변(contravariant) 위치 — unknown은 할당 불가
export const systemToolDefinitions: readonly SystemToolDefinition<any>[] = [
  createWorkspaceDef, listWorkspacesDef, getWorkspaceInfoDef,
  enterWorkspaceDef, inviteMemberDef,
  approveActionDef, rejectActionDef,
  authenticateGwsDef,
];

/** Postback 직접 호출용 핸들러 export */
export const approveActionHandler = approveActionDef.handler;
export const rejectActionHandler = rejectActionDef.handler;


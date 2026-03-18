import type Anthropic from "@anthropic-ai/sdk";

// --- 도구 시스템 ---

/** LINE push 도구명 — executor 조회 및 폴백 전송에 사용 */
export const LINE_PUSH_TEXT_TOOL = "push_text_message";
export const LINE_PUSH_FLEX_TOOL = "push_flex_message";

export type ToolExecutor = (
  input: Record<string, unknown>,
) => Promise<string>;

export interface ToolRegistry {
  tools: Anthropic.Tool[];
  executors: Map<string, ToolExecutor>;
}

// --- 에이전트 ---

export interface AgentResult {
  text: string;
  toolCalls: number;
}

// --- GWS ---

export type GwsCommandResult =
  | { success: true; data: unknown }
  | { success: false; data: null; error: string };

// --- LINE Webhook ---

export interface LineWebhookBody {
  destination: string;
  events: LineWebhookEvent[];
}

export interface LineSource {
  type: string;
  userId?: string;
}

interface LineEventBase {
  source: LineSource;
  timestamp: number;
}

export type LineWebhookEvent =
  | LineMessageEvent
  | LineFollowEvent
  | LineUnfollowEvent
  | LinePostbackEvent;

export interface LineMessageEvent extends LineEventBase {
  type: "message";
  message: LineTextMessage;
  replyToken: string;
}

export interface LineFollowEvent extends LineEventBase {
  type: "follow";
  replyToken: string;
}

export interface LineUnfollowEvent extends LineEventBase {
  type: "unfollow";
}

export interface LinePostbackEvent extends LineEventBase {
  type: "postback";
  postback: { data: string };
  replyToken: string;
}

interface LineTextMessage {
  type: "text";
  id: string;
  text: string;
}

// --- 사용자 ---

export type UserStatus = "invited" | "active" | "inactive";
export type SystemRole = "admin" | "user";

export interface UserRecord {
  status: UserStatus;
  systemRole: SystemRole;
  invitedBy: string;
  invitedAt: string;
  activatedAt?: string;
  deactivatedAt?: string;
  defaultWorkspaceId?: string;
}

// --- 워크스페이스 ---

export type WorkspaceRole = "owner" | "member";

export interface WorkspaceMembership {
  role: WorkspaceRole;
  joinedAt: string;
  invitedBy: string;
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  ownerId: string;
  gwsConfigDir: string;
  gwsAuthenticated: boolean;
  createdAt: string;
  members: Record<string, WorkspaceMembership>;
}

// --- PendingAction (쓰기 승인) ---

export type PendingActionStatus = "pending" | "approved" | "rejected" | "expired";

export interface PendingAction {
  id: string;
  workspaceId: string;
  requesterId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  status: PendingActionStatus;
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  rejectionReason?: string;
  requestContext: string;
}

// --- 도구 컨텍스트 ---

export interface ToolContext {
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
}

export interface AgentDependencies {
  registry: ToolRegistry;
  pendingActionStore: PendingActionStore;
  workspaceStore: WorkspaceStore;
}

// --- Store 인터페이스 (전방 선언) ---

export interface PendingActionStore {
  create(action: Omit<PendingAction, "id" | "status" | "createdAt">): Promise<PendingAction>;
  get(actionId: string): PendingAction | undefined;
  getByWorkspace(workspaceId: string, status?: PendingActionStatus): PendingAction[];
  approve(actionId: string, approvedBy: string): Promise<PendingAction>;
  reject(actionId: string, rejectedBy: string, reason?: string): Promise<PendingAction>;
  expireOlderThan(hours: number): Promise<number>;
  purgeResolved(days: number): Promise<number>;
}

export interface WorkspaceStore {
  getAll(): WorkspaceRecord[];
  get(workspaceId: string): WorkspaceRecord | undefined;
  getByOwner(ownerId: string): WorkspaceRecord[];
  getByMember(userId: string): WorkspaceRecord[];
  create(name: string, ownerId: string): Promise<WorkspaceRecord>;
  inviteMember(workspaceId: string, userId: string, invitedBy: string): Promise<void>;
  removeMember(workspaceId: string, userId: string): Promise<void>;
  resolveWorkspace(userId: string, defaultWorkspaceId?: string): WorkspaceRecord | undefined;
  getUserRole(workspaceId: string, userId: string): WorkspaceRole | undefined;
  setGwsAuthenticated(workspaceId: string, authenticated: boolean): Promise<void>;
}

import type Anthropic from "@anthropic-ai/sdk";
import type { UserStore } from "./users/store.js";
import type { WorkspaceRecord, WorkspaceRole } from "./domain/workspace.js";

// --- 도구 시스템 ---

/** LINE push 도구명 — executor 조회 및 폴백 전송에 사용 */
export const LINE_PUSH_TEXT_TOOL = "push_text_message";
export const LINE_PUSH_FLEX_TOOL = "push_flex_message";

/**
 * 채널 스킬 도구 이름 Set
 *
 * 용도:
 * - MCP Server 도구 필터링 (mcp.ts)
 * - 에이전트 루프에서 channelDelivered 판정 (loop.ts)
 */
export const CHANNEL_SKILL_TOOL_NAMES = new Set([
  LINE_PUSH_TEXT_TOOL,
  LINE_PUSH_FLEX_TOOL,
]);

export type ToolExecutor = (
  input: Record<string, unknown>,
) => Promise<string>;

export interface ToolRegistry {
  tools: Anthropic.Tool[];
  executors: Map<string, ToolExecutor>;
}

// --- 에이전트 내부 도구 공통 규격 ---

/** 에이전트 내부 도구(Infra, System) 핸들러의 공통 반환 시그널 */
export interface InternalToolSignal {
  /** Claude에 반환할 tool_result content */
  toolResult: string;
}

/** 에이전트 내부 도구(Infra, System) 공통 등록 엔트리 */
export interface InternalToolEntry<H> {
  /** Claude에게 보여줄 도구 스키마 */
  def: Anthropic.Tool;
  /** 도구 실행 핸들러 */
  handler: H;
}

// --- 에이전트 ---

export interface AgentResult {
  text: string;
  toolCalls: number;
  /** 에이전트가 채널 스킬 도구로 이미 전달했는지 여부 */
  channelDelivered: boolean;
}

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

export type UserStatus = "active" | "inactive";

/** 초대 출처 */
export type InviteSource =
  | "system"       // 시스템 관리자 자동 등록
  | "self"         // 팔로우로 자가 가입
  | `U${string}`;  // 다른 사용자가 초대 (LINE userId)

export interface UserRecord {
  status: UserStatus;
  invitedBy: InviteSource;
  invitedAt: string;
  activatedAt?: string;
  deactivatedAt?: string;
  lastWorkspaceId?: string;
}

// --- 역할 ---
//
// 2층 구조: WorkspaceRole ⊂ Role
// - WorkspaceRole: 워크스페이스 내 역할 (domain/workspace.ts에서 정의)
// - Role: 에이전트 루프 진입 시 결정되는 런타임 권한 (크로스커팅)

/** 통합 역할 계층: admin > owner > member (ToolContext, 접근 제어용) */
export type Role = "admin" | WorkspaceRole;

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
  /** undefined: System Admin without workspace */
  workspaceId?: string;
  role: Role;
}

export interface AgentDependencies {
  registry: ToolRegistry;
  pendingActionStore: PendingActionStore;
  workspaceStore: WorkspaceStore;
  userStore: UserStore;
  /** 워크스페이스별 GWS 도구 executor 조회 (DI). 토큰 미설정 시 null */
  getGwsExecutors: (workspaceId: string) => Promise<Map<string, ToolExecutor> | null>;
}

// --- Store 인터페이스 ---

export type { UserStore } from "./users/store.js";

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
  resolveWorkspace(userId: string, lastWorkspaceId?: string): WorkspaceRecord | undefined;
  getUserRole(workspaceId: string, userId: string): WorkspaceRole | undefined;
  setGwsAuthenticated(workspaceId: string, authenticated: boolean): Promise<void>;
}

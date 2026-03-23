/**
 * 워크스페이스 도메인 — 데이터 타입 + 순수 함수 (Functional Core)
 *
 * 워크스페이스 관련 도메인 타입 정의 및 검증 규칙 담당. I/O 없음.
 */

// --- 도메인 타입 ---

/** 워크스페이스 내 역할 (영속 저장 대상) */
export type WorkspaceRole = "owner" | "member";

/** 워크스페이스 멤버십 */
export interface WorkspaceMembership {
  role: WorkspaceRole;
  joinedAt: string;
  invitedBy: string;
}

/** OAuth Userinfo API で取得した Google 계정 프로필 */
export interface GwsAccount {
  email: string;
  name?: string;
  picture?: string;
}

/** 워크스페이스 레코드 */
export interface WorkspaceRecord {
  id: string;
  name: string;
  ownerId: string;
  gwsAuthenticated: boolean;
  /** OAuth 인증된 Google 계정 프로필 (인증 시 저장) */
  gwsAccount?: GwsAccount;
  createdAt: string;
  members: Record<string, WorkspaceMembership>;
}

// --- 순수 함수 ---

/** 워크스페이스 이름 최대 길이 */
export const MAX_WORKSPACE_NAME_LENGTH = 64;

/** admin 워크스페이스 소유 상한 */
const ADMIN_MAX_OWNED = 64;

/** 일반 사용자 워크스페이스 소유 상한 */
const USER_MAX_OWNED = 8;

/**
 * 역할에 따른 워크스페이스 소유 상한 반환
 *
 * @param isAdmin - 시스템 관리자 여부
 * @returns 최대 소유 가능 워크스페이스 수
 */
export function getMaxOwnedWorkspaces(isAdmin: boolean): number {
  return isAdmin ? ADMIN_MAX_OWNED : USER_MAX_OWNED;
}

/**
 * 사용자가 새 워크스페이스를 생성할 수 있는지 판정
 *
 * @param ownedCount - 현재 소유 중인 워크스페이스 수
 * @param limit - 사용자당 소유 제한
 * @returns 생성 가능 여부
 */
export function canCreateWorkspace(ownedCount: number, limit: number): boolean {
  return ownedCount < limit;
}

/**
 * 워크스페이스 이름 유효성 검증
 *
 * @param name - 사용자 입력 이름 (트리밍 전)
 * @returns 유효하면 `{ valid: true }`, 아니면 `{ valid: false, error: string }`
 */
export function validateWorkspaceName(
  name: string,
): { valid: true; name: string } | { valid: false; error: string } {
  const trimmed = name.trim();

  if (trimmed.length === 0) {
    return { valid: false, error: "Workspace name cannot be empty." };
  }

  if (trimmed.length > MAX_WORKSPACE_NAME_LENGTH) {
    return {
      valid: false,
      error: `Workspace name must be ${MAX_WORKSPACE_NAME_LENGTH} characters or less.`,
    };
  }

  return { valid: true, name: trimmed };
}

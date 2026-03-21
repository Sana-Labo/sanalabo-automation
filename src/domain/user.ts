/**
 * 사용자 도메인 — 순수 함수 (Functional Core)
 *
 * 상태 전이 규칙만 담당. I/O(저장, 외부 호출) 없음.
 * 모든 함수는 새 객체를 반환하며 입력을 변경하지 않음 (불변).
 */

import type { InviteSource, UserRecord } from "../types.js";

// --- LINE userId 검증 ---

/** LINE userId 형식 검증 (U + 32 hex chars) */
const LINE_USER_ID_PATTERN = /^U[0-9a-f]{32}$/;

/**
 * LINE userId 형식이 유효한지 검증
 *
 * @param userId - 검증 대상 문자열
 * @returns 유효 여부
 */
export function isValidLineUserId(userId: string): boolean {
  return LINE_USER_ID_PATTERN.test(userId);
}

// --- 레코드 생성 ---

/**
 * 신규 사용자 레코드 생성
 *
 * @param source - 등록 출처 (InviteSource)
 * @returns status: "active"인 새 UserRecord
 */
export function createUser(source: InviteSource): UserRecord {
  const now = new Date().toISOString();
  return {
    status: "active",
    invitedBy: source,
    invitedAt: now,
    activatedAt: now,
  };
}

// --- 상태 판별 ---

/** 사용자가 active 상태인지 확인 */
export function isActive(record: UserRecord | undefined): boolean {
  return record?.status === "active";
}

// --- 상태 전이 ---

/**
 * follow 이벤트로 신규 사용자 레코드 생성
 *
 * @returns status: "active", invitedBy: "self"인 새 UserRecord
 */
export function createFromFollow(): UserRecord {
  return createUser("self");
}

/**
 * inactive → active 상태 전이 (재활성화)
 *
 * @param record - 전이 대상 UserRecord
 * @returns 새 UserRecord (status: "active", activatedAt 설정)
 */
export function activate(record: UserRecord): UserRecord {
  return {
    ...record,
    status: "active",
    activatedAt: new Date().toISOString(),
  };
}

// --- 워크스페이스 진입 ---

/**
 * 마지막 진입 워크스페이스 설정
 *
 * @param record - 대상 UserRecord
 * @param workspaceId - 진입할 워크스페이스 ID
 * @returns 새 UserRecord (lastWorkspaceId 설정)
 */
export function setLastWorkspaceId(
  record: UserRecord,
  workspaceId: string,
): UserRecord {
  return { ...record, lastWorkspaceId: workspaceId };
}

// --- 상태 전이 ---

/**
 * active → inactive 상태 전이
 *
 * @param record - 전이 대상 UserRecord
 * @returns 새 UserRecord (status: "inactive", deactivatedAt 설정)
 */
export function deactivate(record: UserRecord): UserRecord {
  return {
    ...record,
    status: "inactive",
    deactivatedAt: new Date().toISOString(),
  };
}

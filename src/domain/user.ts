/**
 * 사용자 도메인 — 순수 함수 (Functional Core)
 *
 * 상태 전이 규칙만 담당. I/O(저장, 외부 호출) 없음.
 * 모든 함수는 새 객체를 반환하며 입력을 변경하지 않음 (불변).
 */

import type { UserRecord } from "../types.js";

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
  const now = new Date().toISOString();
  return {
    status: "active",
    invitedBy: "self",
    invitedAt: now,
    activatedAt: now,
  };
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

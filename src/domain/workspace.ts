/**
 * 워크스페이스 도메인 — 순수 함수 (Functional Core)
 *
 * 워크스페이스 생성 관련 검증 규칙만 담당. I/O 없음.
 */

/** 워크스페이스 이름 최대 길이 */
export const MAX_WORKSPACE_NAME_LENGTH = 64;

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

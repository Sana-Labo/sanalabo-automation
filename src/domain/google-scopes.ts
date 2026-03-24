/**
 * Google OAuth scope 상수 + 순수 헬퍼 함수 (Functional Core)
 *
 * scope URL의 단일 출처. 각 GwsToolDefinition이 requiredScopes로 참조.
 * 도구 추가/변경 시 여기에 scope 상수만 추가하면 consent URL에 자동 반영.
 */

// --- 서비스별 scope 상수 ---

/** Gmail API scope */
export const GmailScope = {
  MODIFY: "https://www.googleapis.com/auth/gmail.modify",
} as const;

/** Google Calendar API scope */
export const CalendarScope = {
  FULL: "https://www.googleapis.com/auth/calendar",
} as const;

/** Google Drive API scope */
export const DriveScope = {
  FULL: "https://www.googleapis.com/auth/drive",
} as const;

/** OpenID Connect / identity scope */
export const IdentityScope = {
  OPENID: "openid",
  EMAIL: "email",
  PROFILE: "profile",
} as const;

// --- 기본 scope ---

/** 기본 scope — 모든 인증에 포함 (도구 무관, 프로필 조회용) */
export const BASE_SCOPES: readonly string[] = [
  IdentityScope.OPENID,
  IdentityScope.EMAIL,
  IdentityScope.PROFILE,
];

// --- 순수 함수 ---

/**
 * 도구 정의 배열에서 필요한 scope 합산 (union + base scopes)
 *
 * consent URL에 전달할 scope 목록을 도구 정의에서 동적으로 계산.
 * `GOOGLE_SCOPES` 하드코딩 상수를 대체.
 *
 * @param toolDefs - requiredScopes를 가진 도구 정의 배열
 * @param baseScopes - 기본 scope (기본값: BASE_SCOPES)
 * @returns 중복 제거된 scope 배열
 */
export function computeRequiredScopes(
  toolDefs: readonly { requiredScopes: readonly string[] }[],
  baseScopes: readonly string[] = BASE_SCOPES,
): string[] {
  const set = new Set(baseScopes);
  for (const def of toolDefs) {
    for (const scope of def.requiredScopes) {
      set.add(scope);
    }
  }
  return [...set];
}

/**
 * 부여된 scope가 필요 scope를 모두 포함하는지 검사
 *
 * @param grantedScopeString - 토큰의 scope 문자열 (space-delimited). undefined/빈 문자열 시 requiredScopes가 비어있어야 true
 * @param requiredScopes - 필요한 scope 배열
 * @returns 모든 required scope가 granted에 포함되어 있으면 true
 */
export function hasSufficientScopes(
  grantedScopeString: string | undefined,
  requiredScopes: readonly string[],
): boolean {
  if (!grantedScopeString) return requiredScopes.length === 0;
  const granted = new Set(grantedScopeString.split(" "));
  return requiredScopes.every((s) => granted.has(s));
}

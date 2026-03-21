/**
 * Google OAuth 도메인 — 순수 함수 (Functional Core)
 *
 * OAuth consent URL 조립, 콜백 파싱, 인증 상태 판정 등
 * 외부 I/O 없음. google-auth-library에 의존하지 않음.
 */

// --- 상수 ---

/**
 * Google OAuth 스코프 (널널한 권한 — 도구 추가 시 재인증 불필요)
 *
 * - gmail.modify: 메일 읽기/쓰기/발송/라벨 변경
 * - calendar: 캘린더 이벤트 읽기/쓰기
 * - drive: 파일 읽기/쓰기/공유
 */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
] as const;

/** OAuth 인증 대기 상태 (인메모리, state → 사용자 매핑) */
export interface PendingAuth {
  userId: string;
  workspaceId: string;
  /** Unix timestamp (ms) */
  expiresAt: number;
}

// --- 순수 함수 ---

/** consent URL 생성 파라미터 */
export interface ConsentUrlParams {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: readonly string[];
}

/**
 * Google OAuth consent URL 조립
 *
 * @param params - OAuth 파라미터
 * @returns 완성된 consent URL 문자열
 */
export function buildConsentUrl(params: ConsentUrlParams): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", (params.scopes ?? GOOGLE_SCOPES).join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", params.state);
  return url.toString();
}

/** OAuth 콜백 파라미터 */
export interface OAuthCallbackParams {
  code: string;
  state: string;
}

/**
 * OAuth 콜백 쿼리 파라미터 파싱 + 검증
 *
 * @param query - URL 쿼리 파라미터 (key-value)
 * @returns 성공 시 code + state, 실패 시 에러 메시지
 */
export function parseCallbackQuery(
  query: Record<string, string>,
): { ok: true; params: OAuthCallbackParams } | { ok: false; error: string } {
  const { code, state, error } = query;
  if (error) return { ok: false, error: `Google OAuth error: ${error}` };
  if (!code) return { ok: false, error: "Missing authorization code" };
  if (!state) return { ok: false, error: "Missing state parameter" };
  return { ok: true, params: { code, state } };
}

/**
 * 인증 대기가 만료되었는지 판정
 *
 * @param auth - 인증 대기 레코드
 * @returns 만료 여부
 */
export function isAuthExpired(auth: PendingAuth): boolean {
  return Date.now() > auth.expiresAt;
}

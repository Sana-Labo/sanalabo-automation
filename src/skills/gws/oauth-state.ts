/**
 * OAuth 인증 대기 상태 관리 (인메모리, 10분 TTL)
 *
 * authenticate_gws System Tool이 state를 생성하고,
 * Google OAuth callback 라우트가 state를 소비(consume)한다.
 */

import type { PendingAuth } from "../../domain/google-oauth.js";

/** 인메모리 state → PendingAuth 맵 */
const pendingAuths = new Map<string, PendingAuth>();

/** 인증 대기 TTL (10분) */
const AUTH_TTL_MS = 10 * 60 * 1000;

/**
 * 새 OAuth 인증 대기 생성
 *
 * @returns state 문자열 (Google OAuth consent URL에 포함)
 */
export function createPendingAuth(userId: string, workspaceId: string): string {
  const state = crypto.randomUUID();
  pendingAuths.set(state, {
    userId,
    workspaceId,
    expiresAt: Date.now() + AUTH_TTL_MS,
  });
  return state;
}

/**
 * state로 인증 대기를 소비 (1회성)
 *
 * 조회 + 삭제 + 만료 검증을 원자적으로 수행.
 *
 * @returns 유효한 PendingAuth 또는 null
 */
export function consumePendingAuth(state: string): PendingAuth | null {
  const auth = pendingAuths.get(state);
  if (!auth) return null;
  pendingAuths.delete(state);
  if (Date.now() > auth.expiresAt) return null;
  return auth;
}

/** 만료된 대기 정리 (주기적 호출 또는 온디맨드) */
export function cleanupExpiredAuths(): number {
  let count = 0;
  const now = Date.now();
  for (const [state, auth] of pendingAuths) {
    if (now > auth.expiresAt) {
      pendingAuths.delete(state);
      count++;
    }
  }
  return count;
}

/** @internal 테스트 전용 — 인메모리 상태 초기화 */
export function _resetForTest(): void {
  pendingAuths.clear();
}

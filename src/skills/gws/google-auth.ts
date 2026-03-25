/**
 * Google OAuth 인증 클라이언트 관리 (Imperative Shell)
 *
 * OAuth2Client 생성, credential 설정, 인가 코드 → 토큰 교환 담당.
 * 순수 도메인 로직(URL 조립, state 검증)은 domain/google-oauth.ts에 위치.
 */

import { OAuth2Client } from "google-auth-library";
import type { GwsAccount } from "../../domain/workspace.js";
import type { GoogleTokens } from "./token-store.js";

/** Google OAuth 설정 */
export interface GoogleAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * OAuth2Client 인스턴스 생성
 *
 * @param config - OAuth 설정 (clientId, clientSecret, redirectUri)
 */
export function createOAuth2Client(config: GoogleAuthConfig): OAuth2Client {
  return new OAuth2Client(config.clientId, config.clientSecret, config.redirectUri);
}

/**
 * OAuth2Client에 기존 토큰 설정 + 토큰 회전 콜백 등록
 *
 * @param client - OAuth2Client 인스턴스
 * @param tokens - 저장된 토큰 (최소 refresh_token 필수)
 * @param onTokenRefresh - 새 refresh_token 발급 시 호출되는 콜백 (토큰 회전 처리)
 */
export function configureClient(
  client: OAuth2Client,
  tokens: GoogleTokens,
  onTokenRefresh?: (updated: GoogleTokens) => void,
): void {
  client.setCredentials({ refresh_token: tokens.refresh_token });

  if (onTokenRefresh) {
    client.on("tokens", (newTokens) => {
      // refresh_token 회전 시에만 저장 (일반 access_token 갱신은 메모리에만 유지)
      if (newTokens.refresh_token) {
        onTokenRefresh({
          ...tokens,
          access_token: newTokens.access_token ?? tokens.access_token,
          refresh_token: newTokens.refresh_token,
          expiry_date: newTokens.expiry_date ?? tokens.expiry_date,
          scope: newTokens.scope ?? tokens.scope,
        });
      }
    });
  }
}

/**
 * 인가 코드를 토큰으로 교환
 *
 * @param client - OAuth2Client (redirectUri 설정 완료 상태)
 * @param code - Google이 callback으로 전달한 authorization code
 * @returns 교환된 토큰 (refresh_token 포함)
 * @throws refresh_token이 응답에 없는 경우
 */
export async function exchangeCode(
  client: OAuth2Client,
  code: string,
): Promise<GoogleTokens> {
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      "No refresh_token received. Ensure access_type=offline and prompt=consent.",
    );
  }
  return {
    access_token: tokens.access_token ?? undefined,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date ?? undefined,
    token_type: tokens.token_type ?? undefined,
    scope: tokens.scope ?? undefined,
  };
}

/** Userinfo API 응답 (v2) */
interface UserinfoResponse {
  id?: string;
  email?: string;
  verified_email?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  locale?: string;
  gender?: string;
  link?: string;
  hd?: string;
}

/**
 * Google Userinfo API로 계정 프로필 조회
 *
 * OAuth scope에 openid + email + profile 필요.
 *
 * @param client - 토큰 설정 완료된 OAuth2Client
 * @returns 계정 프로필 (캐시 저장용 간략 구조)
 * @throws API 호출 실패 시
 */
export async function fetchUserInfo(client: OAuth2Client): Promise<GwsAccount> {
  const res = await client.request<UserinfoResponse>({
    url: "https://www.googleapis.com/oauth2/v2/userinfo",
  });
  const data = res.data;
  if (!data.email) {
    throw new Error("Userinfo API did not return an email address");
  }
  return {
    email: data.email,
    name: data.name,
    picture: data.picture,
  };
}

/**
 * Google Userinfo API로 전체 프로필 조회 (도구용)
 *
 * @param client - 토큰 설정 완료된 OAuth2Client
 * @returns Userinfo API 전체 응답
 * @throws email 필드 누락 시
 */
export async function fetchFullUserInfo(client: OAuth2Client): Promise<UserinfoResponse> {
  const res = await client.request<UserinfoResponse>({
    url: "https://www.googleapis.com/oauth2/v2/userinfo",
  });
  if (!res.data?.email) {
    throw new Error("Userinfo API did not return an email address");
  }
  return res.data;
}

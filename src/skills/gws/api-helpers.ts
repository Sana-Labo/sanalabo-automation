/**
 * GWS API 도메인 헬퍼
 *
 * Gmail, Calendar, Drive API 호출에 사용되는 유틸리티 함수.
 * 도구 정의(gmail-tools.ts 등)의 createExecutor에서 사용.
 */

import type { gmail_v1 } from "@googleapis/gmail";

// --- Gmail 헬퍼 ---

/** Gmail 메시지 payload에서 본문 텍스트 추출 (재귀 MIME 탐색) */
export function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";

  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }

  if (payload.parts) {
    // text/plain 우선
    const textPart = payload.parts.find((p) => p.mimeType === "text/plain");
    if (textPart?.body?.data) {
      return Buffer.from(textPart.body.data, "base64url").toString("utf-8");
    }
    // text/html 폴백
    const htmlPart = payload.parts.find((p) => p.mimeType === "text/html");
    if (htmlPart?.body?.data) {
      return Buffer.from(htmlPart.body.data, "base64url").toString("utf-8");
    }
    // 중첩 multipart 재귀 탐색
    for (const part of payload.parts) {
      const body = extractBody(part);
      if (body) return body;
    }
  }

  return "";
}

/** Gmail 헤더 배열에서 특정 헤더 값 추출 */
export function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string | undefined {
  return headers?.find(
    (h) => h.name?.toLowerCase() === name.toLowerCase(),
  )?.value ?? undefined;
}

/** RFC 2047 MIME encoded-word: 비ASCII 문자가 포함된 헤더 값을 Base64 인코딩 */
export function encodeHeaderValue(value: string): string {
  // ASCII만 포함되면 그대로 반환
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`;
}

/** RFC 2822 형식 raw email 생성 (base64url 인코딩) */
export function buildRawEmail(params: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const lines = [
    `To: ${params.to}`,
    `Subject: ${encodeHeaderValue(params.subject)}`,
    "Content-Type: text/plain; charset=UTF-8",
  ];
  if (params.cc) lines.push(`Cc: ${params.cc}`);
  if (params.bcc) lines.push(`Bcc: ${params.bcc}`);
  if (params.inReplyTo) lines.push(`In-Reply-To: ${params.inReplyTo}`);
  if (params.references) lines.push(`References: ${params.references}`);

  const raw = lines.join("\r\n") + "\r\n\r\n" + params.body;
  return Buffer.from(raw).toString("base64url");
}

// --- Drive 헬퍼 ---

/** Google Apps MIME → 내보내기 MIME 변환 */
export function getExportMimeType(googleMimeType: string): string {
  if (googleMimeType === "application/vnd.google-apps.spreadsheet") return "text/csv";
  return "text/plain";
}

// --- JSON 직렬화 ---

/** 도구 결과를 JSON 문자열로 직렬화 (pretty-print) */
export function jsonResult(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

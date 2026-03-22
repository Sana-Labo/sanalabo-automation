/**
 * Google Workspace API Executor — googleapis 직접 호출 (15개 도구)
 *
 * Gmail, Calendar, Drive API를 in-process로 호출.
 * 각 도구는 ToolExecutor 시그니처 `(input) => Promise<string>` 준수.
 * googleapis 서비스 클라이언트는 외부에서 주입 (테스트 용이).
 */

import type { gmail_v1 } from "@googleapis/gmail";
import type { calendar_v3 } from "@googleapis/calendar";
import type { drive_v3 } from "@googleapis/drive";
import { Readable } from "node:stream";
import type { ToolExecutor } from "../../types.js";
import { toErrorMessage } from "../../utils/error.js";

// --- 입력 추출 헬퍼 ---

function getString(input: Record<string, unknown>, key: string): string {
  const val = input[key];
  if (typeof val !== "string" || val === "") {
    throw new Error(`Missing or invalid parameter: ${key}`);
  }
  return val;
}

function optString(input: Record<string, unknown>, key: string): string | undefined {
  const val = input[key];
  if (val == null) return undefined;
  return String(val);
}

function optNumber(input: Record<string, unknown>, key: string): number | undefined {
  const val = input[key];
  if (val == null) return undefined;
  const n = Number(val);
  if (Number.isNaN(n)) return undefined;
  return n;
}

function optStringArray(input: Record<string, unknown>, key: string): string[] | undefined {
  const val = input[key];
  if (val == null) return undefined;
  if (!Array.isArray(val)) return undefined;
  return val.map(String);
}

// --- Gmail 헬퍼 ---

/** Gmail 메시지 payload에서 본문 텍스트 추출 (재귀 MIME 탐색) */
function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
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
function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string | undefined {
  return headers?.find(
    (h) => h.name?.toLowerCase() === name.toLowerCase(),
  )?.value ?? undefined;
}

/** RFC 2822 형식 raw email 생성 (base64url 인코딩) */
function buildRawEmail(params: {
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
    `Subject: ${params.subject}`,
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
function getExportMimeType(googleMimeType: string): string {
  if (googleMimeType === "application/vnd.google-apps.spreadsheet") return "text/csv";
  return "text/plain";
}

// --- 에러 래퍼 ---

/** ToolExecutor를 에러 핸들링으로 래핑 */
function withErrorHandling(fn: ToolExecutor): ToolExecutor {
  return async (input) => {
    try {
      return await fn(input);
    } catch (e) {
      return `Error: ${toErrorMessage(e)}`;
    }
  };
}

// --- Gmail 도구 (7개) ---

function gmailList(gmail: gmail_v1.Gmail): ToolExecutor {
  return async (input) => {
    const query = optString(input, "query");
    const maxResults = optNumber(input, "maxResults") ?? 10;

    const res = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults,
    });

    if (!res.data.messages?.length) {
      return JSON.stringify({ messages: [], resultSizeEstimate: 0 });
    }

    const messages = await Promise.all(
      res.data.messages.map(async (m) => {
        const msg = await gmail.users.messages.get({
          userId: "me",
          id: m.id!,
          format: "metadata",
          metadataHeaders: ["From", "To", "Subject", "Date"],
        });
        return {
          id: msg.data.id,
          threadId: msg.data.threadId,
          snippet: msg.data.snippet,
          labelIds: msg.data.labelIds,
          from: getHeader(msg.data.payload?.headers, "From"),
          to: getHeader(msg.data.payload?.headers, "To"),
          subject: getHeader(msg.data.payload?.headers, "Subject"),
          date: getHeader(msg.data.payload?.headers, "Date"),
        };
      }),
    );

    return JSON.stringify(
      { messages, resultSizeEstimate: res.data.resultSizeEstimate },
      null,
      2,
    );
  };
}

function gmailGet(gmail: gmail_v1.Gmail): ToolExecutor {
  return async (input) => {
    const messageId = getString(input, "messageId");

    const msg = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

    const headers = msg.data.payload?.headers;
    return JSON.stringify(
      {
        id: msg.data.id,
        threadId: msg.data.threadId,
        labelIds: msg.data.labelIds,
        snippet: msg.data.snippet,
        from: getHeader(headers, "From"),
        to: getHeader(headers, "To"),
        subject: getHeader(headers, "Subject"),
        date: getHeader(headers, "Date"),
        body: extractBody(msg.data.payload ?? undefined),
      },
      null,
      2,
    );
  };
}

function gmailCreateDraft(gmail: gmail_v1.Gmail): ToolExecutor {
  return async (input) => {
    const raw = buildRawEmail({
      to: getString(input, "to"),
      subject: getString(input, "subject"),
      body: getString(input, "body"),
    });

    const res = await gmail.users.drafts.create({
      userId: "me",
      requestBody: { message: { raw } },
    });

    return JSON.stringify(
      { id: res.data.id, message: { id: res.data.message?.id } },
      null,
      2,
    );
  };
}

function gmailSend(gmail: gmail_v1.Gmail): ToolExecutor {
  return async (input) => {
    const raw = buildRawEmail({
      to: getString(input, "to"),
      subject: getString(input, "subject"),
      body: getString(input, "body"),
      cc: optString(input, "cc"),
      bcc: optString(input, "bcc"),
    });

    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });

    return JSON.stringify(
      { id: res.data.id, threadId: res.data.threadId, labelIds: res.data.labelIds },
      null,
      2,
    );
  };
}

function gmailReply(gmail: gmail_v1.Gmail): ToolExecutor {
  return async (input) => {
    const messageId = getString(input, "messageId");
    const body = getString(input, "body");

    // 원본 메시지에서 스레드 정보 추출
    const original = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Message-ID"],
    });

    const headers = original.data.payload?.headers;
    const from = getHeader(headers, "From") ?? "";
    const subject = getHeader(headers, "Subject") ?? "";
    const messageIdHeader = getHeader(headers, "Message-ID");
    const threadId = original.data.threadId;

    const replySubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`;

    const raw = buildRawEmail({
      to: from,
      subject: replySubject,
      body,
      inReplyTo: messageIdHeader,
      references: messageIdHeader,
    });

    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw, threadId },
    });

    return JSON.stringify(
      { id: res.data.id, threadId: res.data.threadId },
      null,
      2,
    );
  };
}

function gmailModifyLabels(gmail: gmail_v1.Gmail): ToolExecutor {
  return async (input) => {
    const messageId = getString(input, "messageId");
    const addLabelIds = optStringArray(input, "addLabelIds");
    const removeLabelIds = optStringArray(input, "removeLabelIds");

    const res = await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: {
        addLabelIds: addLabelIds ?? [],
        removeLabelIds: removeLabelIds ?? [],
      },
    });

    return JSON.stringify(
      { id: res.data.id, labelIds: res.data.labelIds },
      null,
      2,
    );
  };
}

function gmailTrash(gmail: gmail_v1.Gmail): ToolExecutor {
  return async (input) => {
    const messageId = getString(input, "messageId");

    const res = await gmail.users.messages.trash({
      userId: "me",
      id: messageId,
    });

    return JSON.stringify(
      { id: res.data.id, labelIds: res.data.labelIds },
      null,
      2,
    );
  };
}

// --- Calendar 도구 (4개) ---

function calendarList(calendar: calendar_v3.Calendar): ToolExecutor {
  return async (input) => {
    const timeMin = optString(input, "timeMin");
    const timeMax = optString(input, "timeMax");

    const res = await calendar.events.list({
      calendarId: "primary",
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
    });

    const events = (res.data.items ?? []).map((e) => ({
      id: e.id,
      summary: e.summary,
      start: e.start?.dateTime ?? e.start?.date,
      end: e.end?.dateTime ?? e.end?.date,
      description: e.description,
      location: e.location,
      status: e.status,
    }));

    return JSON.stringify({ events }, null, 2);
  };
}

function calendarCreate(calendar: calendar_v3.Calendar): ToolExecutor {
  return async (input) => {
    const summary = getString(input, "summary");
    const start = getString(input, "start");
    const end = getString(input, "end");
    const description = optString(input, "description");

    const res = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary,
        start: { dateTime: start },
        end: { dateTime: end },
        description,
      },
    });

    return JSON.stringify(
      {
        id: res.data.id,
        summary: res.data.summary,
        start: res.data.start?.dateTime,
        end: res.data.end?.dateTime,
        htmlLink: res.data.htmlLink,
      },
      null,
      2,
    );
  };
}

function calendarUpdate(calendar: calendar_v3.Calendar): ToolExecutor {
  return async (input) => {
    const eventId = getString(input, "eventId");
    const summary = optString(input, "summary");
    const start = optString(input, "start");
    const end = optString(input, "end");
    const description = optString(input, "description");

    const requestBody: calendar_v3.Schema$Event = {};
    if (summary !== undefined) requestBody.summary = summary;
    if (start !== undefined) requestBody.start = { dateTime: start };
    if (end !== undefined) requestBody.end = { dateTime: end };
    if (description !== undefined) requestBody.description = description;

    const res = await calendar.events.patch({
      calendarId: "primary",
      eventId,
      requestBody,
    });

    return JSON.stringify(
      {
        id: res.data.id,
        summary: res.data.summary,
        start: res.data.start?.dateTime,
        end: res.data.end?.dateTime,
      },
      null,
      2,
    );
  };
}

function calendarDelete(calendar: calendar_v3.Calendar): ToolExecutor {
  return async (input) => {
    const eventId = getString(input, "eventId");

    await calendar.events.delete({
      calendarId: "primary",
      eventId,
    });

    return JSON.stringify({ deleted: true, eventId });
  };
}

// --- Drive 도구 (4개) ---

function driveSearch(drive: drive_v3.Drive): ToolExecutor {
  return async (input) => {
    const query = getString(input, "query");

    const res = await drive.files.list({
      q: query,
      fields: "files(id,name,mimeType,modifiedTime,size,webViewLink)",
      pageSize: 20,
    });

    return JSON.stringify({ files: res.data.files ?? [] }, null, 2);
  };
}

function driveGetContent(drive: drive_v3.Drive): ToolExecutor {
  return async (input) => {
    const fileId = getString(input, "fileId");

    // 메타데이터 조회
    const meta = await drive.files.get({
      fileId,
      fields: "id,name,mimeType,size,webViewLink",
    });

    const mimeType = meta.data.mimeType ?? "";

    // Google Apps 형식 → export
    if (mimeType.startsWith("application/vnd.google-apps.")) {
      const exportMime = getExportMimeType(mimeType);
      const content = await drive.files.export({
        fileId,
        mimeType: exportMime,
      });
      return JSON.stringify(
        {
          id: fileId,
          name: meta.data.name,
          mimeType,
          content: String(content.data),
        },
        null,
        2,
      );
    }

    // 일반 파일 → 메타데이터만 반환 (바이너리 콘텐츠는 에이전트에 부적합)
    return JSON.stringify(
      {
        id: fileId,
        name: meta.data.name,
        mimeType,
        size: meta.data.size,
        webViewLink: meta.data.webViewLink,
        note: "Binary file content cannot be displayed. Use webViewLink to access.",
      },
      null,
      2,
    );
  };
}

function driveUpload(drive: drive_v3.Drive): ToolExecutor {
  return async (input) => {
    const name = getString(input, "name");
    const content = getString(input, "content");
    const mimeType = optString(input, "mimeType");
    const folderId = optString(input, "folderId");

    const res = await drive.files.create({
      requestBody: {
        name,
        mimeType,
        parents: folderId ? [folderId] : undefined,
      },
      media: {
        mimeType: "text/plain",
        body: Readable.from(content),
      },
      fields: "id,name,mimeType,webViewLink",
    });

    return JSON.stringify(
      {
        id: res.data.id,
        name: res.data.name,
        mimeType: res.data.mimeType,
        webViewLink: res.data.webViewLink,
      },
      null,
      2,
    );
  };
}

function driveShare(drive: drive_v3.Drive): ToolExecutor {
  return async (input) => {
    const fileId = getString(input, "fileId");
    const email = optString(input, "email");
    const role = optString(input, "role") ?? "reader";

    if (email) {
      // 특정 사용자와 공유
      await drive.permissions.create({
        fileId,
        requestBody: {
          type: "user",
          role,
          emailAddress: email,
        },
      });
      return JSON.stringify({ shared: true, fileId, email, role });
    }

    // 공개 링크: 권한 생성 + webViewLink 취득 병렬 실행
    const [, file] = await Promise.all([
      drive.permissions.create({
        fileId,
        requestBody: {
          type: "anyone",
          role,
        },
      }),
      drive.files.get({
        fileId,
        fields: "webViewLink",
      }),
    ]);

    return JSON.stringify({
      shared: true,
      fileId,
      public: true,
      role,
      webViewLink: file.data.webViewLink,
    });
  };
}

// --- 팩토리 ---

/**
 * 15개 GWS 도구의 API executor Map 생성
 *
 * @param gmail - Gmail API v1 클라이언트
 * @param calendar - Calendar API v3 클라이언트
 * @param drive - Drive API v3 클라이언트
 * @returns 도구명 → ToolExecutor 맵
 */
export function createApiExecutors(
  gmail: gmail_v1.Gmail,
  calendar: calendar_v3.Calendar,
  drive: drive_v3.Drive,
): Map<string, ToolExecutor> {
  const executors = new Map<string, ToolExecutor>();

  // Gmail (7)
  executors.set("gmail_list", withErrorHandling(gmailList(gmail)));
  executors.set("gmail_get", withErrorHandling(gmailGet(gmail)));
  executors.set("gmail_create_draft", withErrorHandling(gmailCreateDraft(gmail)));
  executors.set("gmail_send", withErrorHandling(gmailSend(gmail)));
  executors.set("gmail_reply", withErrorHandling(gmailReply(gmail)));
  executors.set("gmail_modify_labels", withErrorHandling(gmailModifyLabels(gmail)));
  executors.set("gmail_trash", withErrorHandling(gmailTrash(gmail)));

  // Calendar (4)
  executors.set("calendar_list", withErrorHandling(calendarList(calendar)));
  executors.set("calendar_create", withErrorHandling(calendarCreate(calendar)));
  executors.set("calendar_update", withErrorHandling(calendarUpdate(calendar)));
  executors.set("calendar_delete", withErrorHandling(calendarDelete(calendar)));

  // Drive (4)
  executors.set("drive_search", withErrorHandling(driveSearch(drive)));
  executors.set("drive_get_content", withErrorHandling(driveGetContent(drive)));
  executors.set("drive_upload", withErrorHandling(driveUpload(drive)));
  executors.set("drive_share", withErrorHandling(driveShare(drive)));

  return executors;
}

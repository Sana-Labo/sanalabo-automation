/**
 * Gmail 도구 (7개) — GwsToolDefinition 자기 완결적 구조
 *
 * Zod 스키마가 단일 출처. createExecutor로 Gmail API 클라이언트 주입.
 */
import { z } from "zod";
import { gwsTool, type GwsToolDefinition } from "../../agent/tool-definition.js";
import { extractBody, getHeader, buildRawEmail, jsonResult } from "./api-helpers.js";

// --- 스키마 ---

const gmailListSchema = z.object({
  query: z.string().describe("Gmail search query. Omit to list recent emails.").optional(),
  maxResults: z.number().describe("Maximum number of results to return (default: 10)").optional(),
});

const gmailGetSchema = z.object({
  messageId: z.string().describe("The Gmail message ID"),
});

const gmailCreateDraftSchema = z.object({
  to: z.string().describe("Recipient email address"),
  subject: z.string().describe("Email subject"),
  body: z.string().describe("Email body text"),
});

const gmailSendSchema = z.object({
  to: z.string().describe("Recipient email address"),
  subject: z.string().describe("Email subject"),
  body: z.string().describe("Email body text"),
  cc: z.string().describe("CC recipients (comma-separated)").optional(),
  bcc: z.string().describe("BCC recipients (comma-separated)").optional(),
});

const gmailReplySchema = z.object({
  messageId: z.string().describe("The Gmail message ID to reply to"),
  body: z.string().describe("Reply body text"),
});

const gmailModifyLabelsSchema = z.object({
  messageId: z.string().describe("The Gmail message ID"),
  addLabelIds: z.array(z.string()).describe("Label IDs to add (e.g. 'STARRED', 'IMPORTANT')").optional(),
  removeLabelIds: z.array(z.string()).describe("Label IDs to remove (e.g. 'INBOX' for archive, 'UNREAD' for mark-as-read)").optional(),
});

const gmailTrashSchema = z.object({
  messageId: z.string().describe("The Gmail message ID to trash"),
});

// --- 도구 정의 ---

export const gmailList = gwsTool({
  name: "gmail_list",
  description:
    "List or search emails in Gmail. Supports full Gmail search syntax (e.g. 'is:unread', 'from:user@example.com', 'newer_than:1h is:important').",
  inputSchema: gmailListSchema,
  createExecutor: (s) => async (input) => {
    const res = await s.gmail.users.messages.list({
      userId: "me",
      q: input.query,
      maxResults: input.maxResults ?? 10,
    });

    if (!res.data.messages?.length) {
      return jsonResult({ messages: [], resultSizeEstimate: 0 });
    }

    const messages = await Promise.all(
      res.data.messages.map(async (m) => {
        const msg = await s.gmail.users.messages.get({
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

    return jsonResult({ messages, resultSizeEstimate: res.data.resultSizeEstimate });
  },
});

export const gmailGet = gwsTool({
  name: "gmail_get",
  description: "Get a specific email message by ID with full content.",
  inputSchema: gmailGetSchema,
  createExecutor: (s) => async (input) => {
    const msg = await s.gmail.users.messages.get({
      userId: "me",
      id: input.messageId,
      format: "full",
    });

    const headers = msg.data.payload?.headers;
    return jsonResult({
      id: msg.data.id,
      threadId: msg.data.threadId,
      labelIds: msg.data.labelIds,
      snippet: msg.data.snippet,
      from: getHeader(headers, "From"),
      to: getHeader(headers, "To"),
      subject: getHeader(headers, "Subject"),
      date: getHeader(headers, "Date"),
      body: extractBody(msg.data.payload ?? undefined),
    });
  },
});

export const gmailCreateDraft = gwsTool({
  name: "gmail_create_draft",
  description:
    "Create a draft email in Gmail. This does NOT send the email — it only saves a draft. After creating, inform the user that the draft has been saved and they must send it from Gmail.",
  concurrency: "write",
  inputSchema: gmailCreateDraftSchema,
  createExecutor: (s) => async (input) => {
    const raw = buildRawEmail({
      to: input.to,
      subject: input.subject,
      body: input.body,
    });

    const res = await s.gmail.users.drafts.create({
      userId: "me",
      requestBody: { message: { raw } },
    });

    return jsonResult({ id: res.data.id, message: { id: res.data.message?.id } });
  },
});

export const gmailSend = gwsTool({
  name: "gmail_send",
  description:
    "Send an email. This action is irreversible — always confirm with the user before sending.",
  concurrency: "write",
  inputSchema: gmailSendSchema,
  createExecutor: (s) => async (input) => {
    const raw = buildRawEmail({
      to: input.to,
      subject: input.subject,
      body: input.body,
      cc: input.cc,
      bcc: input.bcc,
    });

    const res = await s.gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });

    return jsonResult({ id: res.data.id, threadId: res.data.threadId, labelIds: res.data.labelIds });
  },
});

export const gmailReply = gwsTool({
  name: "gmail_reply",
  description:
    "Reply to an existing email thread. This action is irreversible — always confirm with the user before replying.",
  concurrency: "write",
  inputSchema: gmailReplySchema,
  createExecutor: (s) => async (input) => {
    // 원본 메시지에서 스레드 정보 추출
    const original = await s.gmail.users.messages.get({
      userId: "me",
      id: input.messageId,
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
      body: input.body,
      inReplyTo: messageIdHeader,
      references: messageIdHeader,
    });

    const res = await s.gmail.users.messages.send({
      userId: "me",
      requestBody: { raw, threadId },
    });

    return jsonResult({ id: res.data.id, threadId: res.data.threadId });
  },
});

export const gmailModifyLabels = gwsTool({
  name: "gmail_modify_labels",
  description:
    "Add or remove labels from an email. Use this for archiving (remove INBOX), marking as read (remove UNREAD), starring, etc.",
  concurrency: "write",
  inputSchema: gmailModifyLabelsSchema,
  createExecutor: (s) => async (input) => {
    const res = await s.gmail.users.messages.modify({
      userId: "me",
      id: input.messageId,
      requestBody: {
        addLabelIds: input.addLabelIds ?? [],
        removeLabelIds: input.removeLabelIds ?? [],
      },
    });

    return jsonResult({ id: res.data.id, labelIds: res.data.labelIds });
  },
});

export const gmailTrash = gwsTool({
  name: "gmail_trash",
  description: "Move an email to the trash.",
  concurrency: "write",
  inputSchema: gmailTrashSchema,
  createExecutor: (s) => async (input) => {
    const res = await s.gmail.users.messages.trash({
      userId: "me",
      id: input.messageId,
    });

    return jsonResult({ id: res.data.id, labelIds: res.data.labelIds });
  },
});

/** Gmail 도구 정의 배열 */
export const gmailToolDefinitions: readonly GwsToolDefinition<any>[] = [
  gmailList, gmailGet, gmailCreateDraft, gmailSend,
  gmailReply, gmailModifyLabels, gmailTrash,
];

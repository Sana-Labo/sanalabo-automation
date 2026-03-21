import { describe, test, expect, beforeEach } from "bun:test";
import type { gmail_v1 } from "@googleapis/gmail";
import type { calendar_v3 } from "@googleapis/calendar";
import type { drive_v3 } from "@googleapis/drive";
import { createApiExecutors } from "./api-executor.js";

// --- Mock 팩토리 ---

function createMockGmail() {
  return {
    users: {
      messages: {
        list: async () => ({
          data: {
            messages: [{ id: "msg1", threadId: "t1" }],
            resultSizeEstimate: 1,
          },
        }),
        get: async (_params: Record<string, unknown>) => ({
          data: {
            id: "msg1",
            threadId: "t1",
            labelIds: ["INBOX"],
            snippet: "Hello world",
            payload: {
              headers: [
                { name: "From", value: "sender@test.com" },
                { name: "To", value: "me@test.com" },
                { name: "Subject", value: "Test Subject" },
                { name: "Date", value: "2026-03-21" },
                { name: "Message-ID", value: "<abc@test.com>" },
              ],
              body: {
                data: Buffer.from("Hello body text").toString("base64url"),
              },
            },
          },
        }),
        send: async () => ({
          data: { id: "sent1", threadId: "t1", labelIds: ["SENT"] },
        }),
        modify: async () => ({
          data: { id: "msg1", labelIds: ["STARRED"] },
        }),
        trash: async () => ({
          data: { id: "msg1", labelIds: ["TRASH"] },
        }),
      },
      drafts: {
        create: async () => ({
          data: { id: "draft1", message: { id: "msg-draft1" } },
        }),
      },
    },
  } as unknown as gmail_v1.Gmail;
}

function createMockCalendar() {
  return {
    events: {
      list: async () => ({
        data: {
          items: [
            {
              id: "evt1",
              summary: "Meeting",
              start: { dateTime: "2026-03-21T10:00:00+09:00" },
              end: { dateTime: "2026-03-21T11:00:00+09:00" },
              description: "Team meeting",
              location: "Room A",
              status: "confirmed",
            },
          ],
        },
      }),
      insert: async () => ({
        data: {
          id: "evt2",
          summary: "New Event",
          start: { dateTime: "2026-03-22T09:00:00+09:00" },
          end: { dateTime: "2026-03-22T10:00:00+09:00" },
          htmlLink: "https://calendar.google.com/event/evt2",
        },
      }),
      patch: async () => ({
        data: {
          id: "evt1",
          summary: "Updated Meeting",
          start: { dateTime: "2026-03-21T11:00:00+09:00" },
          end: { dateTime: "2026-03-21T12:00:00+09:00" },
        },
      }),
      delete: async () => ({ data: undefined }),
    },
  } as unknown as calendar_v3.Calendar;
}

function createMockDrive() {
  return {
    files: {
      list: async () => ({
        data: {
          files: [
            {
              id: "file1",
              name: "doc.txt",
              mimeType: "text/plain",
              modifiedTime: "2026-03-21T00:00:00Z",
              size: "1024",
              webViewLink: "https://drive.google.com/file/file1",
            },
          ],
        },
      }),
      get: async () => ({
        data: {
          id: "file1",
          name: "doc.txt",
          mimeType: "text/plain",
          size: "1024",
          webViewLink: "https://drive.google.com/file/file1",
        },
      }),
      export: async () => ({
        data: "Exported document content",
      }),
      create: async () => ({
        data: {
          id: "file2",
          name: "uploaded.txt",
          mimeType: "text/plain",
          webViewLink: "https://drive.google.com/file/file2",
        },
      }),
    },
    permissions: {
      create: async () => ({ data: {} }),
    },
  } as unknown as drive_v3.Drive;
}

// --- 테스트 ---

describe("createApiExecutors", () => {
  let executors: Map<string, ToolExecutor>;
  let mockGmail: gmail_v1.Gmail;
  let mockCalendar: calendar_v3.Calendar;
  let mockDrive: drive_v3.Drive;

  // ToolExecutor 타입을 import 없이 추론
  type ToolExecutor = (input: Record<string, unknown>) => Promise<string>;

  beforeEach(() => {
    mockGmail = createMockGmail();
    mockCalendar = createMockCalendar();
    mockDrive = createMockDrive();
    executors = createApiExecutors(mockGmail, mockCalendar, mockDrive);
  });

  test("15개 도구 등록", () => {
    expect(executors.size).toBe(15);
  });

  // --- Gmail ---

  describe("gmail_list", () => {
    test("메일 목록 조회", async () => {
      const result = JSON.parse(await executors.get("gmail_list")!({}));
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].id).toBe("msg1");
      expect(result.messages[0].from).toBe("sender@test.com");
      expect(result.messages[0].subject).toBe("Test Subject");
    });

    test("빈 결과", async () => {
      mockGmail.users.messages.list = (async () => ({
        data: { messages: null, resultSizeEstimate: 0 },
      })) as unknown as typeof mockGmail.users.messages.list;

      const result = JSON.parse(await executors.get("gmail_list")!({}));
      expect(result.messages).toHaveLength(0);
    });
  });

  describe("gmail_get", () => {
    test("메일 상세 조회 (본문 포함)", async () => {
      const result = JSON.parse(
        await executors.get("gmail_get")!({ messageId: "msg1" }),
      );
      expect(result.id).toBe("msg1");
      expect(result.body).toBe("Hello body text");
      expect(result.from).toBe("sender@test.com");
    });
  });

  describe("gmail_create_draft", () => {
    test("초안 생성", async () => {
      const result = JSON.parse(
        await executors.get("gmail_create_draft")!({
          to: "to@test.com",
          subject: "Draft Subject",
          body: "Draft body",
        }),
      );
      expect(result.id).toBe("draft1");
    });
  });

  describe("gmail_send", () => {
    test("메일 발송", async () => {
      const result = JSON.parse(
        await executors.get("gmail_send")!({
          to: "to@test.com",
          subject: "Send Subject",
          body: "Send body",
        }),
      );
      expect(result.id).toBe("sent1");
      expect(result.labelIds).toContain("SENT");
    });
  });

  describe("gmail_reply", () => {
    test("답장 발송 (스레드 유지)", async () => {
      const result = JSON.parse(
        await executors.get("gmail_reply")!({
          messageId: "msg1",
          body: "Reply body",
        }),
      );
      expect(result.id).toBe("sent1");
      expect(result.threadId).toBe("t1");
    });
  });

  describe("gmail_modify_labels", () => {
    test("라벨 수정", async () => {
      const result = JSON.parse(
        await executors.get("gmail_modify_labels")!({
          messageId: "msg1",
          addLabelIds: ["STARRED"],
          removeLabelIds: ["INBOX"],
        }),
      );
      expect(result.id).toBe("msg1");
    });
  });

  describe("gmail_trash", () => {
    test("휴지통 이동", async () => {
      const result = JSON.parse(
        await executors.get("gmail_trash")!({ messageId: "msg1" }),
      );
      expect(result.id).toBe("msg1");
      expect(result.labelIds).toContain("TRASH");
    });
  });

  // --- Calendar ---

  describe("calendar_list", () => {
    test("일정 조회", async () => {
      const result = JSON.parse(await executors.get("calendar_list")!({}));
      expect(result.events).toHaveLength(1);
      expect(result.events[0].summary).toBe("Meeting");
      expect(result.events[0].location).toBe("Room A");
    });
  });

  describe("calendar_create", () => {
    test("일정 생성", async () => {
      const result = JSON.parse(
        await executors.get("calendar_create")!({
          summary: "New Event",
          start: "2026-03-22T09:00:00+09:00",
          end: "2026-03-22T10:00:00+09:00",
        }),
      );
      expect(result.id).toBe("evt2");
      expect(result.htmlLink).toContain("calendar.google.com");
    });
  });

  describe("calendar_update", () => {
    test("일정 수정", async () => {
      const result = JSON.parse(
        await executors.get("calendar_update")!({
          eventId: "evt1",
          summary: "Updated Meeting",
        }),
      );
      expect(result.id).toBe("evt1");
      expect(result.summary).toBe("Updated Meeting");
    });
  });

  describe("calendar_delete", () => {
    test("일정 삭제", async () => {
      const result = JSON.parse(
        await executors.get("calendar_delete")!({ eventId: "evt1" }),
      );
      expect(result.deleted).toBe(true);
    });
  });

  // --- Drive ---

  describe("drive_search", () => {
    test("파일 검색", async () => {
      const result = JSON.parse(
        await executors.get("drive_search")!({ query: "name contains 'doc'" }),
      );
      expect(result.files).toHaveLength(1);
      expect(result.files[0].name).toBe("doc.txt");
    });
  });

  describe("drive_get_content", () => {
    test("일반 파일 → 메타데이터 반환", async () => {
      const result = JSON.parse(
        await executors.get("drive_get_content")!({ fileId: "file1" }),
      );
      expect(result.name).toBe("doc.txt");
      expect(result.note).toContain("Binary file");
    });

    test("Google Docs → export 텍스트 반환", async () => {
      mockDrive.files.get = (async () => ({
        data: {
          id: "gdoc1",
          name: "My Document",
          mimeType: "application/vnd.google-apps.document",
        },
      })) as typeof mockDrive.files.get;

      const result = JSON.parse(
        await executors.get("drive_get_content")!({ fileId: "gdoc1" }),
      );
      expect(result.content).toBe("Exported document content");
      expect(result.name).toBe("My Document");
    });
  });

  describe("drive_upload", () => {
    test("파일 업로드", async () => {
      const result = JSON.parse(
        await executors.get("drive_upload")!({
          name: "uploaded.txt",
          content: "file content",
        }),
      );
      expect(result.id).toBe("file2");
      expect(result.name).toBe("uploaded.txt");
    });
  });

  describe("drive_share", () => {
    test("사용자에게 공유", async () => {
      const result = JSON.parse(
        await executors.get("drive_share")!({
          fileId: "file1",
          email: "user@test.com",
          role: "writer",
        }),
      );
      expect(result.shared).toBe(true);
      expect(result.email).toBe("user@test.com");
    });

    test("공개 링크", async () => {
      const result = JSON.parse(
        await executors.get("drive_share")!({ fileId: "file1" }),
      );
      expect(result.shared).toBe(true);
      expect(result.public).toBe(true);
    });
  });

  // --- 에러 핸들링 ---

  describe("에러 핸들링", () => {
    test("API 에러 시 Error: 메시지 반환", async () => {
      mockGmail.users.messages.list = (async () => {
        throw new Error("Rate Limit Exceeded");
      }) as typeof mockGmail.users.messages.list;

      const result = await executors.get("gmail_list")!({});
      expect(result).toContain("Error:");
      expect(result).toContain("Rate Limit Exceeded");
    });

    test("필수 파라미터 누락 시 에러", async () => {
      const result = await executors.get("gmail_get")!({});
      expect(result).toContain("Error:");
      expect(result).toContain("messageId");
    });
  });
});

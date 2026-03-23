/**
 * Drive 도구 (4개) — GwsToolDefinition 자기 완결적 구조
 *
 * Zod 스키마가 단일 출처. createExecutor로 Drive API 클라이언트 주입.
 */
import { z } from "zod";
import { Readable } from "node:stream";
import { gwsTool, type GwsToolDefinition } from "../../agent/tool-definition.js";
import { getExportMimeType, jsonResult } from "./api-helpers.js";

// --- 스키마 ---

const driveSearchSchema = z.object({
  query: z.string().describe("Drive search query"),
});

const driveGetContentSchema = z.object({
  fileId: z.string().describe("The Drive file ID"),
});

const driveUploadSchema = z.object({
  name: z.string().describe("File name"),
  content: z.string().describe("File content (text)"),
  mimeType: z.string().describe("Target MIME type. Use 'application/vnd.google-apps.document' to create a Google Doc.").optional(),
  folderId: z.string().describe("Parent folder ID (optional, defaults to root)").optional(),
});

const driveShareSchema = z.object({
  fileId: z.string().describe("The Drive file or folder ID"),
  email: z.string().describe("Email address to share with (omit for public link)").optional(),
  role: z.enum(["reader", "commenter", "writer"]).describe("Permission role (default: 'reader')").optional(),
});

// --- 도구 정의 ---

export const driveSearch = gwsTool({
  name: "drive_search",
  description: "Search files in Google Drive.",
  inputSchema: driveSearchSchema,
  createExecutor: (s) => async (input) => {
    const res = await s.drive.files.list({
      q: input.query,
      fields: "files(id,name,mimeType,modifiedTime,size,webViewLink)",
      pageSize: 20,
    });

    return jsonResult({ files: res.data.files ?? [] });
  },
});

export const driveGetContent = gwsTool({
  name: "drive_get_content",
  description:
    "Get the content of a file from Google Drive. For Google Docs/Sheets/Slides, exports as text. For other files, returns metadata.",
  inputSchema: driveGetContentSchema,
  createExecutor: (s) => async (input) => {
    // 메타데이터 조회
    const meta = await s.drive.files.get({
      fileId: input.fileId,
      fields: "id,name,mimeType,size,webViewLink",
    });

    const mimeType = meta.data.mimeType ?? "";

    // Google Apps 형식 → export
    if (mimeType.startsWith("application/vnd.google-apps.")) {
      const exportMime = getExportMimeType(mimeType);
      const content = await s.drive.files.export({
        fileId: input.fileId,
        mimeType: exportMime,
      });
      return jsonResult({
        id: input.fileId,
        name: meta.data.name,
        mimeType,
        content: String(content.data),
      });
    }

    // 일반 파일 → 메타데이터만 반환
    return jsonResult({
      id: input.fileId,
      name: meta.data.name,
      mimeType,
      size: meta.data.size,
      webViewLink: meta.data.webViewLink,
      note: "Binary file content cannot be displayed. Use webViewLink to access.",
    });
  },
});

export const driveUpload = gwsTool({
  name: "drive_upload",
  description:
    "Upload a text file to Google Drive. For creating Google Docs, set mimeType to 'application/vnd.google-apps.document'.",
  inputSchema: driveUploadSchema,
  createExecutor: (s) => async (input) => {
    const res = await s.drive.files.create({
      requestBody: {
        name: input.name,
        mimeType: input.mimeType,
        parents: input.folderId ? [input.folderId] : undefined,
      },
      media: {
        mimeType: "text/plain",
        body: Readable.from(input.content),
      },
      fields: "id,name,mimeType,webViewLink",
    });

    return jsonResult({
      id: res.data.id,
      name: res.data.name,
      mimeType: res.data.mimeType,
      webViewLink: res.data.webViewLink,
    });
  },
});

export const driveShare = gwsTool({
  name: "drive_share",
  description: "Share a file or folder with a user or make it public.",
  inputSchema: driveShareSchema,
  createExecutor: (s) => async (input) => {
    const role = input.role ?? "reader";

    if (input.email) {
      // 특정 사용자와 공유
      await s.drive.permissions.create({
        fileId: input.fileId,
        requestBody: {
          type: "user",
          role,
          emailAddress: input.email,
        },
      });
      return jsonResult({ shared: true, fileId: input.fileId, email: input.email, role });
    }

    // 공개 링크: 권한 생성 + webViewLink 취득 병렬 실행
    const [, file] = await Promise.all([
      s.drive.permissions.create({
        fileId: input.fileId,
        requestBody: {
          type: "anyone",
          role,
        },
      }),
      s.drive.files.get({
        fileId: input.fileId,
        fields: "webViewLink",
      }),
    ]);

    return jsonResult({
      shared: true,
      fileId: input.fileId,
      public: true,
      role,
      webViewLink: file.data.webViewLink,
    });
  },
});

/** Drive 도구 정의 배열 */
export const driveToolDefinitions: readonly GwsToolDefinition<any>[] = [
  driveSearch, driveGetContent, driveUpload, driveShare,
];

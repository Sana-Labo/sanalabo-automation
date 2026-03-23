import { describe, expect, test } from "bun:test";
import { gwsToolDefinitions } from "./tools.js";
import { toAnthropicTool } from "../../agent/tool-definition.js";

/** 헬퍼: ToolDefinition → Anthropic.Tool 변환 배열 */
const gwsTools = gwsToolDefinitions.map((d) => toAnthropicTool(d));

describe("gwsToolDefinitions", () => {
  test("15개 도구 정의", () => {
    expect(gwsToolDefinitions).toHaveLength(15);
  });

  test("GWS 도구는 non-strict (strict tool 제한 20개 준수)", () => {
    for (const tool of gwsTools) {
      expect(tool.strict).toBeUndefined();
    }
  });

  test("모든 도구 input_schema에 additionalProperties: false 설정", () => {
    for (const tool of gwsTools) {
      expect(tool.input_schema.additionalProperties).toBe(false);
    }
  });

  test("optional-only 도구(gmail_list, calendar_list)에 required 없거나 빈 배열", () => {
    const optionalOnlyTools = gwsTools.filter(
      (t) => t.name === "gmail_list" || t.name === "calendar_list",
    );
    expect(optionalOnlyTools).toHaveLength(2);

    for (const tool of optionalOnlyTools) {
      const required = tool.input_schema.required as string[] | undefined;
      expect(!required || required.length === 0).toBe(true);
    }
  });

  test("기존 도구 required 유지", () => {
    const gmailGet = gwsTools.find((t) => t.name === "gmail_get");
    expect(gmailGet!.input_schema.required).toEqual(["messageId"]);

    const gmailDraft = gwsTools.find((t) => t.name === "gmail_create_draft");
    expect(gmailDraft!.input_schema.required).toEqual(["to", "subject", "body"]);

    const calendarCreate = gwsTools.find((t) => t.name === "calendar_create");
    expect(calendarCreate!.input_schema.required).toEqual(["summary", "start", "end"]);

    const driveSearch = gwsTools.find((t) => t.name === "drive_search");
    expect(driveSearch!.input_schema.required).toEqual(["query"]);
  });

  test("신규 도구 required 필드 검증", () => {
    const gmailSend = gwsTools.find((t) => t.name === "gmail_send");
    expect(gmailSend!.input_schema.required).toEqual(["to", "subject", "body"]);

    const gmailReply = gwsTools.find((t) => t.name === "gmail_reply");
    expect(gmailReply!.input_schema.required).toEqual(["messageId", "body"]);

    const gmailModify = gwsTools.find((t) => t.name === "gmail_modify_labels");
    expect(gmailModify!.input_schema.required).toEqual(["messageId"]);

    const gmailTrash = gwsTools.find((t) => t.name === "gmail_trash");
    expect(gmailTrash!.input_schema.required).toEqual(["messageId"]);

    const calendarUpdate = gwsTools.find((t) => t.name === "calendar_update");
    expect(calendarUpdate!.input_schema.required).toEqual(["eventId"]);

    const calendarDelete = gwsTools.find((t) => t.name === "calendar_delete");
    expect(calendarDelete!.input_schema.required).toEqual(["eventId"]);

    const driveGetContent = gwsTools.find((t) => t.name === "drive_get_content");
    expect(driveGetContent!.input_schema.required).toEqual(["fileId"]);

    const driveUpload = gwsTools.find((t) => t.name === "drive_upload");
    expect(driveUpload!.input_schema.required).toEqual(["name", "content"]);

    const driveShare = gwsTools.find((t) => t.name === "drive_share");
    expect(driveShare!.input_schema.required).toEqual(["fileId"]);
  });

  test("도구 이름 고유성", () => {
    const names = gwsTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("Gmail 도구 7개", () => {
    const gmailTools = gwsTools.filter((t) => t.name.startsWith("gmail_"));
    expect(gmailTools).toHaveLength(7);
  });

  test("Calendar 도구 4개", () => {
    const calTools = gwsTools.filter((t) => t.name.startsWith("calendar_"));
    expect(calTools).toHaveLength(4);
  });

  test("Drive 도구 4개", () => {
    const driveTools = gwsTools.filter((t) => t.name.startsWith("drive_"));
    expect(driveTools).toHaveLength(4);
  });
});

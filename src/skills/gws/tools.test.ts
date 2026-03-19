import { describe, expect, test } from "bun:test";
import { gwsTools } from "./tools.js";

describe("gwsTools", () => {
  test("모든 도구에 strict: true 설정", () => {
    for (const tool of gwsTools) {
      expect(tool.strict).toBe(true);
    }
  });

  test("모든 도구 input_schema에 additionalProperties: false 설정", () => {
    for (const tool of gwsTools) {
      expect(tool.input_schema.additionalProperties).toBe(false);
    }
  });

  test("optional-only 도구(gmail_list, calendar_list)에 빈 required 배열 존재", () => {
    const optionalOnlyTools = gwsTools.filter(
      (t) => t.name === "gmail_list" || t.name === "calendar_list",
    );
    expect(optionalOnlyTools).toHaveLength(2);

    for (const tool of optionalOnlyTools) {
      expect(tool.input_schema.required).toEqual([]);
    }
  });

  test("required 필드가 있는 도구는 기존 required 유지", () => {
    const gmailGet = gwsTools.find((t) => t.name === "gmail_get");
    expect(gmailGet!.input_schema.required).toEqual(["messageId"]);

    const gmailDraft = gwsTools.find((t) => t.name === "gmail_create_draft");
    expect(gmailDraft!.input_schema.required).toEqual(["to", "subject", "body"]);

    const calendarCreate = gwsTools.find((t) => t.name === "calendar_create");
    expect(calendarCreate!.input_schema.required).toEqual(["summary", "start", "end"]);

    const driveSearch = gwsTools.find((t) => t.name === "drive_search");
    expect(driveSearch!.input_schema.required).toEqual(["query"]);
  });
});

import { describe, expect, test, mock } from "bun:test";
import { gwsToolDefinitions } from "./tools.js";
import { toAnthropicTool, type GwsServices, type GwsToolDefinition } from "../../agent/tool-definition.js";

/** 헬퍼: ToolDefinition → Anthropic.Tool 변환 배열 */
const gwsTools = gwsToolDefinitions.map((d) => toAnthropicTool(d));

describe("gwsToolDefinitions", () => {
  test("16개 도구 정의", () => {
    expect(gwsToolDefinitions).toHaveLength(16);
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

  test("get_gws_account 도구 포함 + required: role", () => {
    const tool = gwsTools.find((t) => t.name === "get_gws_account");
    expect(tool).toBeDefined();
    expect(tool!.input_schema.required).toEqual(["role"]);
  });
});

// --- get_gws_account executor 테스트 ---

describe("get_gws_account executor", () => {
  const fullProfile = {
    id: "123456",
    email: "user@example.com",
    verified_email: true,
    name: "Test User",
    given_name: "Test",
    family_name: "User",
    picture: "https://example.com/photo.jpg",
    locale: "ko",
    hd: "example.com",
  };

  function getAccountDef(): GwsToolDefinition<any> {
    return gwsToolDefinitions.find((d) => d.name === "get_gws_account")!;
  }

  function makeMockServices(overrides?: { fetchFail?: boolean }): GwsServices {
    const mockAuth = {
      request: overrides?.fetchFail
        ? mock(() => Promise.reject(new Error("auth error")))
        : mock(() => Promise.resolve({ data: fullProfile })),
    };
    return {
      auth: mockAuth as any,
      gmail: {} as any,
      calendar: {} as any,
      drive: {} as any,
    };
  }

  test("owner: 전체 필드 반환", async () => {
    const services = makeMockServices();
    const executor = getAccountDef().createExecutor(services);

    const result = JSON.parse(await executor({ role: "owner" }));

    expect(result.id).toBe("123456");
    expect(result.email).toBe("user@example.com");
    expect(result.given_name).toBe("Test");
    expect(result.family_name).toBe("User");
    expect(result.hd).toBe("example.com");
  });

  test("admin: 전체 필드 반환", async () => {
    const services = makeMockServices();
    const executor = getAccountDef().createExecutor(services);

    const result = JSON.parse(await executor({ role: "admin" }));

    expect(result.id).toBe("123456");
    expect(result.hd).toBe("example.com");
  });

  test("member: 식별용 필드만 반환 (id, given_name, family_name, hd 제외)", async () => {
    const services = makeMockServices();
    const executor = getAccountDef().createExecutor(services);

    const result = JSON.parse(await executor({ role: "member" }));

    expect(result.email).toBe("user@example.com");
    expect(result.name).toBe("Test User");
    expect(result.verified_email).toBe(true);
    expect(result.picture).toBe("https://example.com/photo.jpg");
    expect(result.locale).toBe("ko");
    // 비공개 필드 미포함
    expect(result.id).toBeUndefined();
    expect(result.given_name).toBeUndefined();
    expect(result.family_name).toBeUndefined();
    expect(result.hd).toBeUndefined();
  });

  test("API 실패 시 재인증 안내 반환 (에러 throw 없음)", async () => {
    const services = makeMockServices({ fetchFail: true });
    const executor = getAccountDef().createExecutor(services);

    const result = JSON.parse(await executor({ role: "owner" }));

    expect(result.error).toContain("re-authentication");
  });
});

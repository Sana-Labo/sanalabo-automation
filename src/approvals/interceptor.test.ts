import { describe, test, expect } from "bun:test";
import { interceptWrite } from "./interceptor.js";
import type { PendingAction, PendingActionStore, ToolContext } from "../types.js";

const mockStore: PendingActionStore = {
  create: async (input) => ({
    ...input,
    id: "test-id",
    status: "pending" as const,
    createdAt: new Date().toISOString(),
  }),
  get: () => undefined,
  getByWorkspace: () => [],
  approve: async () => {
    throw new Error("not implemented");
  },
  reject: async () => {
    throw new Error("not implemented");
  },
  expireOlderThan: async () => 0,
  purgeResolved: async () => 0,
};

function makeContext(role: "owner" | "member"): ToolContext {
  return {
    userId: "U_user_123",
    workspaceId: "ws_001",
    role,
  };
}

describe("interceptWrite", () => {
  test("owner + read tool → not intercepted", async () => {
    const result = await interceptWrite(
      "gmail_list",
      { query: "is:unread" },
      makeContext("owner"),
      mockStore,
      "メール一覧を見せて",
    );
    expect(result.intercepted).toBe(false);
  });

  test("owner + write tool → not intercepted (owner is always allowed)", async () => {
    const result = await interceptWrite(
      "gmail_create_draft",
      { to: "a@b.com", subject: "hi", body: "hello" },
      makeContext("owner"),
      mockStore,
      "メール下書き作成",
    );
    expect(result.intercepted).toBe(false);
  });

  test("member + read tool → not intercepted", async () => {
    const result = await interceptWrite(
      "gmail_list",
      { query: "is:unread" },
      makeContext("member"),
      mockStore,
      "メール一覧を見せて",
    );
    expect(result.intercepted).toBe(false);
  });

  test("member + write tool (gmail_create_draft) → intercepted with pendingAction", async () => {
    const result = await interceptWrite(
      "gmail_create_draft",
      { to: "a@b.com", subject: "hi", body: "hello" },
      makeContext("member"),
      mockStore,
      "メール下書き作成",
    );
    expect(result.intercepted).toBe(true);
    if (result.intercepted) {
      expect(result.pendingAction).toBeDefined();
      expect(result.pendingAction.status).toBe("pending");
    }
  });

  test("member + write tool (calendar_create) → intercepted", async () => {
    const result = await interceptWrite(
      "calendar_create",
      { summary: "Meeting", start: "2026-01-01T09:00:00", end: "2026-01-01T10:00:00" },
      makeContext("member"),
      mockStore,
      "予定を作成して",
    );
    expect(result.intercepted).toBe(true);
  });

  test("pendingAction fields match the input context", async () => {
    const toolInput = { to: "x@y.com", subject: "test", body: "body" };
    const context = makeContext("member");
    const requestContext = "テストリクエスト";

    const result = await interceptWrite(
      "gmail_create_draft",
      toolInput,
      context,
      mockStore,
      requestContext,
    );

    expect(result.intercepted).toBe(true);
    if (result.intercepted) {
      const pa = result.pendingAction;
      expect(pa.workspaceId).toBe(context.workspaceId);
      expect(pa.requesterId).toBe(context.userId);
      expect(pa.toolName).toBe("gmail_create_draft");
      expect(pa.toolInput).toEqual(toolInput);
      expect(pa.requestContext).toBe(requestContext);
      expect(pa.id).toBe("test-id");
    }
  });
});

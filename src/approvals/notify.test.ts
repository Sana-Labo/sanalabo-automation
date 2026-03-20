import { describe, test, expect } from "bun:test";
import { notifyOwnerOfPending, notifyActionResult } from "./notify.js";
import type { WorkspaceRecord } from "../domain/workspace.js";
import { LINE_PUSH_FLEX_TOOL, LINE_PUSH_TEXT_TOOL, type PendingAction, type ToolRegistry, type WorkspaceStore } from "../types.js";

function makePendingAction(overrides: Partial<PendingAction> = {}): PendingAction {
  return {
    id: "action-001",
    workspaceId: "ws_001",
    requesterId: "U_member_1",
    toolName: "gmail_create_draft",
    toolInput: { to: "a@b.com", subject: "hi", body: "hello" },
    status: "pending",
    createdAt: "2024-01-01T00:00:00.000Z",
    requestContext: "Create an email draft",
    ...overrides,
  };
}

function makeWorkspace(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    id: "ws_001",
    name: "TestWS",
    ownerId: "U_owner_1",
    gwsConfigDir: "/data/workspaces/ws_001/gws-config",
    gwsAuthenticated: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    members: {
      U_owner_1: { role: "owner", joinedAt: "2024-01-01T00:00:00.000Z", invitedBy: "system" },
      U_member_1: { role: "member", joinedAt: "2024-01-01T00:00:00.000Z", invitedBy: "U_owner_1" },
    },
    ...overrides,
  };
}

interface CallRecord {
  input: Record<string, unknown>;
}

function makeRegistry(options: {
  hasFlex?: boolean;
  hasText?: boolean;
} = {}): { registry: ToolRegistry; flexCalls: CallRecord[]; textCalls: CallRecord[] } {
  const flexCalls: CallRecord[] = [];
  const textCalls: CallRecord[] = [];
  const executors = new Map<string, (input: Record<string, unknown>) => Promise<string>>();

  if (options.hasFlex !== false) {
    executors.set(LINE_PUSH_FLEX_TOOL, async (input) => {
      flexCalls.push({ input });
      return "ok";
    });
  }
  if (options.hasText !== false) {
    executors.set(LINE_PUSH_TEXT_TOOL, async (input) => {
      textCalls.push({ input });
      return "ok";
    });
  }

  return {
    registry: { tools: [], executors },
    flexCalls,
    textCalls,
  };
}

function makeWorkspaceStore(workspace?: WorkspaceRecord): WorkspaceStore {
  return {
    getAll: () => (workspace ? [workspace] : []),
    get: (id: string) => (workspace && workspace.id === id ? workspace : undefined),
    getByOwner: () => (workspace ? [workspace] : []),
    getByMember: () => (workspace ? [workspace] : []),
    create: async () => {
      throw new Error("not implemented");
    },
    inviteMember: async () => {},
    removeMember: async () => {},
    resolveWorkspace: () => workspace,
    getUserRole: () => undefined,
    setGwsAuthenticated: async () => {},
  };
}

describe("notifyOwnerOfPending", () => {
  test("sends Flex Message when push_flex_message executor exists", async () => {
    const action = makePendingAction();
    const ws = makeWorkspace();
    const { registry, flexCalls, textCalls } = makeRegistry({ hasFlex: true, hasText: true });

    await notifyOwnerOfPending(action, registry, makeWorkspaceStore(ws));

    expect(flexCalls).toHaveLength(1);
    expect(flexCalls[0]!.input.user_id).toBe(ws.ownerId);
    expect(textCalls).toHaveLength(0);
  });

  test("falls back to push_text_message when push_flex_message is not available", async () => {
    const action = makePendingAction();
    const ws = makeWorkspace();
    const { registry, flexCalls, textCalls } = makeRegistry({ hasFlex: false, hasText: true });

    await notifyOwnerOfPending(action, registry, makeWorkspaceStore(ws));

    expect(flexCalls).toHaveLength(0);
    expect(textCalls).toHaveLength(1);
    expect(textCalls[0]!.input.user_id).toBe(ws.ownerId);
    const messages = textCalls[0]!.input.messages as Array<{ type: string; text: string }>;
    const text = messages[0]!.text;
    expect(text).toContain("Approval Request");
    expect(text).toContain(action.toolName);
  });

  test("does nothing when workspace is not found", async () => {
    const action = makePendingAction({ workspaceId: "ws_nonexistent" });
    const { registry, flexCalls, textCalls } = makeRegistry({ hasFlex: true, hasText: true });

    await notifyOwnerOfPending(action, registry, makeWorkspaceStore(undefined));

    expect(flexCalls).toHaveLength(0);
    expect(textCalls).toHaveLength(0);
  });
});

describe("notifyActionResult", () => {
  test("approved status includes Approved text", async () => {
    const action = makePendingAction({ status: "approved" });
    const { registry, textCalls } = makeRegistry({ hasFlex: false, hasText: true });

    await notifyActionResult(action, registry, "U_member_1");

    expect(textCalls).toHaveLength(1);
    const messages = textCalls[0]!.input.messages as Array<{ type: string; text: string }>;
    const text = messages[0]!.text;
    expect(text).toContain("Approved");
    expect(text).toContain(action.toolName);
  });

  test("rejected status with reason includes Rejected and reason", async () => {
    const action = makePendingAction({
      status: "rejected",
      rejectionReason: "Inappropriate content",
    });
    const { registry, textCalls } = makeRegistry({ hasFlex: false, hasText: true });

    await notifyActionResult(action, registry, "U_member_1");

    expect(textCalls).toHaveLength(1);
    const messages = textCalls[0]!.input.messages as Array<{ type: string; text: string }>;
    const text = messages[0]!.text;
    expect(text).toContain("Rejected");
    expect(text).toContain("Inappropriate content");
  });

  test("executionError includes Execution error text", async () => {
    const action = makePendingAction({ status: "approved" });
    const { registry, textCalls } = makeRegistry({ hasFlex: false, hasText: true });

    await notifyActionResult(action, registry, "U_member_1", "GWS API timeout");

    expect(textCalls).toHaveLength(1);
    const messages = textCalls[0]!.input.messages as Array<{ type: string; text: string }>;
    const text = messages[0]!.text;
    expect(text).toContain("Execution error");
    expect(text).toContain("GWS API timeout");
  });

  test("does nothing when push_text_message executor is not available", async () => {
    const action = makePendingAction({ status: "approved" });
    const { registry, textCalls } = makeRegistry({ hasFlex: false, hasText: false });

    await notifyActionResult(action, registry, "U_member_1");

    expect(textCalls).toHaveLength(0);
  });
});

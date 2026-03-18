import { describe, test, expect } from "bun:test";
import { buildSystemPrompt } from "./system.js";
import type { ToolContext, WorkspaceRecord } from "../types.js";

// --- 픽스처 ---

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    userId: "Uowner1234",
    workspaceId: "ws-001",
    role: "owner",
    ...overrides,
  };
}

function makeWorkspace(overrides?: Partial<WorkspaceRecord>): WorkspaceRecord {
  return {
    id: "ws-001",
    name: "TestWorkspace",
    ownerId: "Uowner1234",
    gwsConfigDir: "data/workspaces/ws-001/gws-config",
    gwsAuthenticated: true,
    createdAt: "2024-01-01T00:00:00Z",
    members: {
      Uowner1234: {
        role: "owner",
        joinedAt: "2024-01-01T00:00:00Z",
        invitedBy: "system",
      },
    },
    ...overrides,
  };
}

// --- 테스트 ---

describe("buildSystemPrompt", () => {
  test("owner role includes full access description", () => {
    const prompt = buildSystemPrompt(makeContext(), makeWorkspace());
    expect(prompt).toContain("full access to all Google Workspace");
  });

  test("member role includes approval requirement description", () => {
    const prompt = buildSystemPrompt(
      makeContext({ role: "member", userId: "Umember5678" }),
      makeWorkspace(),
    );
    expect(prompt).toContain("owner's approval");
  });

  test("member role does not include owner full-access text", () => {
    const prompt = buildSystemPrompt(
      makeContext({ role: "member", userId: "Umember5678" }),
      makeWorkspace(),
    );
    expect(prompt).not.toContain("full access to all Google Workspace");
  });

  test("workspace name is included in prompt", () => {
    const prompt = buildSystemPrompt(
      makeContext(),
      makeWorkspace({ name: "MyClub" }),
    );
    expect(prompt).toContain("MyClub");
  });

  test("context userId is included in prompt", () => {
    const userId = "Uowner1234";
    const prompt = buildSystemPrompt(makeContext({ userId }), makeWorkspace());
    expect(prompt).toContain(userId);
  });

  test("different userId is reflected", () => {
    const prompt = buildSystemPrompt(
      makeContext({ userId: "Uxyz9999" }),
      makeWorkspace(),
    );
    expect(prompt).toContain("Uxyz9999");
  });

  test("undefined workspace shows 'Unknown'", () => {
    const prompt = buildSystemPrompt(makeContext(), undefined);
    expect(prompt).toContain("Unknown");
  });

  test("prompt contains role field", () => {
    const prompt = buildSystemPrompt(makeContext({ role: "owner" }), makeWorkspace());
    expect(prompt).toContain("Your role: owner");
  });

  test("prompt contains safety rules", () => {
    const prompt = buildSystemPrompt(makeContext(), makeWorkspace());
    expect(prompt).toContain("Never send emails");
    expect(prompt).toContain("Confirm before adding calendar events");
  });

  test("prompt contains message format guidelines", () => {
    const prompt = buildSystemPrompt(makeContext(), makeWorkspace());
    expect(prompt).toContain("2000 characters");
  });
});

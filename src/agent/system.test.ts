import { describe, test, expect } from "bun:test";
import { buildSystemPrompt } from "./system.js";
import type { WorkspaceRecord } from "../domain/workspace.js";
import type { ToolContext } from "../types.js";

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

  test("prompt contains no_action guidance", () => {
    const prompt = buildSystemPrompt(makeContext(), makeWorkspace());
    expect(prompt).toContain("no_action");
  });

  test("prompt contains message delivery guidance", () => {
    const prompt = buildSystemPrompt(makeContext(), makeWorkspace());
    expect(prompt).toContain("automatically delivered");
    expect(prompt).toContain("Message Delivery");
  });

  test("prompt does not contain Response Rules or userId", () => {
    const prompt = buildSystemPrompt(makeContext({ userId: "Uxyz9999" }), makeWorkspace());
    expect(prompt).not.toContain("Response Rules");
    expect(prompt).not.toContain("Uxyz9999");
  });

  describe("GWS authentication notice", () => {
    test("gwsAuthenticated: false → 인증 필요 안내 포함", () => {
      const prompt = buildSystemPrompt(
        makeContext(),
        makeWorkspace({ gwsAuthenticated: false }),
      );
      expect(prompt).toContain("authentication");
      expect(prompt).toContain("unavailable");
    });

    test("gwsAuthenticated: true → 인증 안내 미포함", () => {
      const prompt = buildSystemPrompt(
        makeContext(),
        makeWorkspace({ gwsAuthenticated: true }),
      );
      expect(prompt).not.toContain("Authentication");
      expect(prompt).not.toContain("unavailable");
    });
  });

  describe("admin role (no workspace)", () => {
    test("admin prompt does not contain GWS-related content", () => {
      const prompt = buildSystemPrompt(
        makeContext({ role: "admin", workspaceId: undefined }),
        undefined,
      );
      expect(prompt).not.toContain("Google Workspace");
      expect(prompt).not.toContain("Workspace");
      expect(prompt).not.toContain("Gmail");
      expect(prompt).not.toContain("Calendar");
      expect(prompt).not.toContain("Safety Rules");
    });

    test("admin prompt contains no_action guidance and message format", () => {
      const prompt = buildSystemPrompt(
        makeContext({ role: "admin", workspaceId: undefined }),
        undefined,
      );
      expect(prompt).toContain("no_action");
      expect(prompt).toContain("2000 characters");
    });

    test("admin prompt contains current time", () => {
      const prompt = buildSystemPrompt(
        makeContext({ role: "admin", workspaceId: undefined }),
        undefined,
      );
      expect(prompt).toContain("JST");
    });

    test("admin prompt contains language rules", () => {
      const prompt = buildSystemPrompt(
        makeContext({ role: "admin", workspaceId: undefined }),
        undefined,
      );
      expect(prompt).toContain("Language");
    });
  });

  describe("admin role with workspace (fallthrough to GWS prompt)", () => {
    test("admin + workspaceId → GWS prompt with Safety Rules", () => {
      const prompt = buildSystemPrompt(
        makeContext({ role: "admin", workspaceId: "ws-001" }),
        makeWorkspace(),
      );
      expect(prompt).toContain("Google Workspace");
      expect(prompt).toContain("Safety Rules");
      expect(prompt).toContain("Never send emails");
    });
  });

  describe("onboarding (member, no workspace, no userWorkspaces)", () => {
    test("contains service introduction", () => {
      const prompt = buildSystemPrompt(
        makeContext({ role: "member", workspaceId: undefined }),
        undefined,
        [],
      );
      expect(prompt).toContain("onboarding");
    });

    test("contains create_workspace guidance", () => {
      const prompt = buildSystemPrompt(
        makeContext({ role: "member", workspaceId: undefined }),
        undefined,
        [],
      );
      expect(prompt).toContain("create_workspace");
    });

    test("does not contain GWS-specific content", () => {
      const prompt = buildSystemPrompt(
        makeContext({ role: "member", workspaceId: undefined }),
        undefined,
        [],
      );
      expect(prompt).not.toContain("Safety Rules");
      expect(prompt).not.toContain("Never send emails");
      expect(prompt).not.toContain("Your role:");
    });

    test("does not contain enter_workspace guidance", () => {
      const prompt = buildSystemPrompt(
        makeContext({ role: "member", workspaceId: undefined }),
        undefined,
        [],
      );
      expect(prompt).not.toContain("enter_workspace");
    });
  });

  describe("out-stage (member, no workspace, has userWorkspaces)", () => {
    const userWs = [
      makeWorkspace({ id: "ws-001", name: "MyClub", ownerId: "Uowner1234" }),
      makeWorkspace({ id: "ws-002", name: "TeamB", ownerId: "Uother9999" }),
    ];

    test("contains workspace navigation guidance", () => {
      const prompt = buildSystemPrompt(
        makeContext({ role: "member", workspaceId: undefined }),
        undefined,
        userWs,
      );
      expect(prompt).toContain("navigation");
      expect(prompt).toContain("enter_workspace");
    });

    test("lists available workspaces with names and IDs", () => {
      const prompt = buildSystemPrompt(
        makeContext({ role: "member", workspaceId: undefined }),
        undefined,
        userWs,
      );
      expect(prompt).toContain("MyClub");
      expect(prompt).toContain("ws-001");
      expect(prompt).toContain("TeamB");
      expect(prompt).toContain("ws-002");
    });

    test("shows correct role for each workspace", () => {
      const prompt = buildSystemPrompt(
        makeContext({ role: "member", workspaceId: undefined, userId: "Uowner1234" }),
        undefined,
        userWs,
      );
      // Uowner1234 owns ws-001, is member of ws-002
      expect(prompt).toContain("owner");
      expect(prompt).toContain("member");
    });

    test("does not contain GWS-specific content or safety rules", () => {
      const prompt = buildSystemPrompt(
        makeContext({ role: "member", workspaceId: undefined }),
        undefined,
        userWs,
      );
      expect(prompt).not.toContain("Safety Rules");
      expect(prompt).not.toContain("Never send emails");
    });

    test("does not contain onboarding content", () => {
      const prompt = buildSystemPrompt(
        makeContext({ role: "member", workspaceId: undefined }),
        undefined,
        userWs,
      );
      expect(prompt).not.toContain("onboarding");
      expect(prompt).not.toContain("just joined");
    });
  });
});

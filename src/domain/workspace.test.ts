import { describe, test, expect } from "bun:test";
import {
  canCreateWorkspace,
  getMaxOwnedWorkspaces,
  isWorkspaceNameTaken,
  validateWorkspaceName,
  MAX_WORKSPACE_NAME_LENGTH,
} from "./workspace.js";

describe("domain/workspace", () => {
  describe("canCreateWorkspace", () => {
    test("소유 0개 + 제한 1 → true", () => {
      expect(canCreateWorkspace(0, 1)).toBe(true);
    });

    test("소유 1개 + 제한 1 → false", () => {
      expect(canCreateWorkspace(1, 1)).toBe(false);
    });

    test("소유 0개 + 제한 3 → true", () => {
      expect(canCreateWorkspace(0, 3)).toBe(true);
    });

    test("소유 2개 + 제한 3 → true", () => {
      expect(canCreateWorkspace(2, 3)).toBe(true);
    });

    test("소유 3개 + 제한 3 → false", () => {
      expect(canCreateWorkspace(3, 3)).toBe(false);
    });
  });

  describe("getMaxOwnedWorkspaces", () => {
    test("admin: 64", () => {
      expect(getMaxOwnedWorkspaces(true)).toBe(64);
    });

    test("일반 사용자: 8", () => {
      expect(getMaxOwnedWorkspaces(false)).toBe(8);
    });
  });

  describe("validateWorkspaceName", () => {
    test("유효한 이름 → valid: true + 트리밍된 이름 반환", () => {
      expect(validateWorkspaceName("동아리A")).toEqual({ valid: true, name: "동아리A" });
    });

    test("영문 이름 허용", () => {
      expect(validateWorkspaceName("MyWorkspace")).toEqual({ valid: true, name: "MyWorkspace" });
    });

    test("숫자 포함 허용", () => {
      expect(validateWorkspaceName("팀123")).toEqual({ valid: true, name: "팀123" });
    });

    test("빈 문자열 → valid: false + error 메시지", () => {
      const result = validateWorkspaceName("");
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toBeDefined();
    });

    test("공백만 → valid: false + error 메시지", () => {
      const result = validateWorkspaceName("   ");
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toBeDefined();
    });

    test("1글자 허용", () => {
      expect(validateWorkspaceName("A")).toEqual({ valid: true, name: "A" });
    });

    test("MAX_WORKSPACE_NAME_LENGTH 글자 허용", () => {
      const name = "A".repeat(MAX_WORKSPACE_NAME_LENGTH);
      expect(validateWorkspaceName(name)).toEqual({ valid: true, name });
    });

    test("MAX_WORKSPACE_NAME_LENGTH + 1 글자 → valid: false + error 메시지", () => {
      const result = validateWorkspaceName("A".repeat(MAX_WORKSPACE_NAME_LENGTH + 1));
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toBeDefined();
    });

    test("앞뒤 공백은 트리밍 후 검증", () => {
      expect(validateWorkspaceName("  동아리A  ")).toEqual({ valid: true, name: "동아리A" });
    });

    test("트리밍 후 빈 문자열 → valid: false", () => {
      const result = validateWorkspaceName("   ");
      expect(result.valid).toBe(false);
    });
  });

  describe("isWorkspaceNameTaken", () => {
    test("동일 이름 존재 → true", () => {
      expect(isWorkspaceNameTaken(["Work", "Personal"], "Work")).toBe(true);
    });

    test("동일 이름 없음 → false", () => {
      expect(isWorkspaceNameTaken(["Work", "Personal"], "School")).toBe(false);
    });

    test("대소문자 무시 비교", () => {
      expect(isWorkspaceNameTaken(["MyClub"], "myclub")).toBe(true);
      expect(isWorkspaceNameTaken(["myclub"], "MYCLUB")).toBe(true);
    });

    test("빈 배열 → false", () => {
      expect(isWorkspaceNameTaken([], "Work")).toBe(false);
    });

    test("앞뒤 공백이 있는 입력도 트리밍 후 비교", () => {
      expect(isWorkspaceNameTaken(["Work"], "  Work  ")).toBe(true);
    });
  });
});

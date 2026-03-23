import { describe, test, expect } from "bun:test";
import { isActive, isValidLineUserId, createFromFollow, activate, deactivate, setLastWorkspaceId, clearLastWorkspaceId } from "./user.js";
import type { UserRecord } from "../types.js";

describe("domain/user", () => {
  describe("isActive", () => {
    test("returns true for active record", () => {
      expect(isActive({ status: "active", invitedBy: "self", invitedAt: "" })).toBe(true);
    });

    test("returns false for inactive record", () => {
      expect(isActive({ status: "inactive", invitedBy: "self", invitedAt: "" })).toBe(false);
    });

    test("returns false for undefined", () => {
      expect(isActive(undefined)).toBe(false);
    });
  });

  describe("isValidLineUserId", () => {
    test("유효한 LINE userId (U + 32 hex)", () => {
      expect(isValidLineUserId("Ua0000000000000000000000000000001")).toBe(true);
    });

    test("빈 문자열: false", () => {
      expect(isValidLineUserId("")).toBe(false);
    });

    test("U 없음: false", () => {
      expect(isValidLineUserId("a0000000000000000000000000000001")).toBe(false);
    });

    test("31자 hex: false (짧음)", () => {
      expect(isValidLineUserId("U000000000000000000000000000001")).toBe(false);
    });

    test("대문자 hex: false (소문자만 허용)", () => {
      expect(isValidLineUserId("UA000000000000000000000000000001")).toBe(false);
    });
  });

  describe("createFromFollow", () => {
    test("returns active record with invitedBy 'self'", () => {
      const record = createFromFollow();

      expect(record.status).toBe("active");
      expect(record.invitedBy).toBe("self");
      expect(record.activatedAt).toBeDefined();
      expect(record.invitedAt).toBeDefined();
    });

    test("invitedAt and activatedAt are valid ISO strings", () => {
      const record = createFromFollow();

      expect(() => new Date(record.invitedAt).toISOString()).not.toThrow();
      expect(() => new Date(record.activatedAt!).toISOString()).not.toThrow();
    });
  });

  describe("activate", () => {
    test("inactive → active with activatedAt set", () => {
      const inactive: UserRecord = {
        status: "inactive",
        invitedBy: "self",
        invitedAt: "2024-01-01T00:00:00.000Z",
        deactivatedAt: "2024-01-02T00:00:00.000Z",
      };

      const result = activate(inactive);

      expect(result.status).toBe("active");
      expect(result.activatedAt).toBeDefined();
      // 원본 불변 확인
      expect(inactive.status).toBe("inactive");
      expect(inactive.activatedAt).toBeUndefined();
    });

    test("preserves existing fields", () => {
      const inactive: UserRecord = {
        status: "inactive",
        invitedBy: "Uowner1234567890abcdef1234567890",
        invitedAt: "2024-01-01T00:00:00.000Z",
        lastWorkspaceId: "ws-001",
      };

      const result = activate(inactive);

      expect(result.invitedBy).toBe("Uowner1234567890abcdef1234567890");
      expect(result.invitedAt).toBe("2024-01-01T00:00:00.000Z");
      expect(result.lastWorkspaceId).toBe("ws-001");
    });
  });

  describe("setLastWorkspaceId", () => {
    test("lastWorkspaceId를 설정한 새 레코드 반환", () => {
      const record: UserRecord = {
        status: "active",
        invitedBy: "self",
        invitedAt: "2024-01-01T00:00:00.000Z",
      };

      const result = setLastWorkspaceId(record, "ws-123");

      expect(result.lastWorkspaceId).toBe("ws-123");
      // 원본 불변 확인
      expect(record.lastWorkspaceId).toBeUndefined();
    });

    test("기존 lastWorkspaceId를 덮어씀", () => {
      const record: UserRecord = {
        status: "active",
        invitedBy: "self",
        invitedAt: "2024-01-01T00:00:00.000Z",
        lastWorkspaceId: "ws-old",
      };

      const result = setLastWorkspaceId(record, "ws-new");

      expect(result.lastWorkspaceId).toBe("ws-new");
      expect(record.lastWorkspaceId).toBe("ws-old");
    });

    test("다른 필드 보존", () => {
      const record: UserRecord = {
        status: "active",
        invitedBy: "Uowner1234567890abcdef1234567890",
        invitedAt: "2024-01-01T00:00:00.000Z",
        activatedAt: "2024-01-02T00:00:00.000Z",
      };

      const result = setLastWorkspaceId(record, "ws-123");

      expect(result.status).toBe("active");
      expect(result.invitedBy).toBe("Uowner1234567890abcdef1234567890");
      expect(result.activatedAt).toBe("2024-01-02T00:00:00.000Z");
    });
  });

  describe("clearLastWorkspaceId", () => {
    test("lastWorkspaceId を undefined にした新レコードを返す", () => {
      const record: UserRecord = {
        status: "active",
        invitedBy: "self",
        invitedAt: "2024-01-01T00:00:00.000Z",
        lastWorkspaceId: "ws-123",
      };

      const result = clearLastWorkspaceId(record);

      expect(result.lastWorkspaceId).toBeUndefined();
      // 원본 불변 확인
      expect(record.lastWorkspaceId).toBe("ws-123");
    });

    test("lastWorkspaceId가 이미 없어도 에러 없음", () => {
      const record: UserRecord = {
        status: "active",
        invitedBy: "self",
        invitedAt: "2024-01-01T00:00:00.000Z",
      };

      const result = clearLastWorkspaceId(record);

      expect(result.lastWorkspaceId).toBeUndefined();
    });

    test("다른 필드 보존", () => {
      const record: UserRecord = {
        status: "active",
        invitedBy: "Uowner1234567890abcdef1234567890",
        invitedAt: "2024-01-01T00:00:00.000Z",
        activatedAt: "2024-01-02T00:00:00.000Z",
        lastWorkspaceId: "ws-old",
      };

      const result = clearLastWorkspaceId(record);

      expect(result.status).toBe("active");
      expect(result.invitedBy).toBe("Uowner1234567890abcdef1234567890");
      expect(result.activatedAt).toBe("2024-01-02T00:00:00.000Z");
    });
  });

  describe("deactivate", () => {
    test("active → inactive with deactivatedAt set", () => {
      const active: UserRecord = {
        status: "active",
        invitedBy: "self",
        invitedAt: "2024-01-01T00:00:00.000Z",
        activatedAt: "2024-01-01T00:00:00.000Z",
      };

      const result = deactivate(active);

      expect(result.status).toBe("inactive");
      expect(result.deactivatedAt).toBeDefined();
      // 원본 불변 확인
      expect(active.status).toBe("active");
      expect(active.deactivatedAt).toBeUndefined();
    });

    test("preserves existing fields", () => {
      const active: UserRecord = {
        status: "active",
        invitedBy: "Uowner1234567890abcdef1234567890",
        invitedAt: "2024-01-01T00:00:00.000Z",
        activatedAt: "2024-01-02T00:00:00.000Z",
        lastWorkspaceId: "ws-001",
      };

      const result = deactivate(active);

      expect(result.invitedBy).toBe("Uowner1234567890abcdef1234567890");
      expect(result.activatedAt).toBe("2024-01-02T00:00:00.000Z");
      expect(result.lastWorkspaceId).toBe("ws-001");
    });
  });
});

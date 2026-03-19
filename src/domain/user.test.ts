import { describe, test, expect } from "bun:test";
import { createFromFollow, activate, deactivate } from "./user.js";
import type { UserRecord } from "../types.js";

describe("domain/user", () => {
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
    test("invited → active with activatedAt set", () => {
      const invited: UserRecord = {
        status: "invited",
        invitedBy: "Uowner1234567890abcdef1234567890",
        invitedAt: "2024-01-01T00:00:00.000Z",
      };

      const result = activate(invited);

      expect(result.status).toBe("active");
      expect(result.activatedAt).toBeDefined();
      // 원본 불변 확인
      expect(invited.status).toBe("invited");
      expect(invited.activatedAt).toBeUndefined();
    });

    test("preserves existing fields", () => {
      const invited: UserRecord = {
        status: "invited",
        invitedBy: "Uowner1234567890abcdef1234567890",
        invitedAt: "2024-01-01T00:00:00.000Z",
        defaultWorkspaceId: "ws-001",
      };

      const result = activate(invited);

      expect(result.invitedBy).toBe("Uowner1234567890abcdef1234567890");
      expect(result.invitedAt).toBe("2024-01-01T00:00:00.000Z");
      expect(result.defaultWorkspaceId).toBe("ws-001");
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
        defaultWorkspaceId: "ws-001",
      };

      const result = deactivate(active);

      expect(result.invitedBy).toBe("Uowner1234567890abcdef1234567890");
      expect(result.activatedAt).toBe("2024-01-02T00:00:00.000Z");
      expect(result.defaultWorkspaceId).toBe("ws-001");
    });
  });
});

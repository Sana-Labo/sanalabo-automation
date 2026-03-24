import { describe, test, expect } from "bun:test";
import { canExecute } from "./access.js";

describe("canExecute", () => {
  describe("owner role", () => {
    test("owner can execute read tools", () => {
      expect(canExecute("read", "owner")).toBe("allow");
      expect(canExecute(undefined, "owner")).toBe("allow");
    });

    test("owner can execute write tools", () => {
      expect(canExecute("write", "owner")).toBe("allow");
    });

    test("owner can execute dynamic tools", () => {
      expect(canExecute("dynamic", "owner", true)).toBe("allow");
      expect(canExecute("dynamic", "owner", false)).toBe("allow");
    });
  });

  describe("member role", () => {
    test("member can execute read tools", () => {
      expect(canExecute("read", "member")).toBe("allow");
      expect(canExecute(undefined, "member")).toBe("allow");
    });

    test("member needs approval for write tools", () => {
      expect(canExecute("write", "member")).toBe("needs_approval");
    });

    test("member + dynamic(mutating) needs approval", () => {
      expect(canExecute("dynamic", "member", true)).toBe("needs_approval");
    });

    test("member + dynamic(non-mutating) is allowed", () => {
      expect(canExecute("dynamic", "member", false)).toBe("allow");
      expect(canExecute("dynamic", "member")).toBe("allow");
    });
  });

  describe("admin role", () => {
    test("admin can execute read tools", () => {
      expect(canExecute("read", "admin")).toBe("allow");
    });

    test("admin can execute write tools without approval", () => {
      expect(canExecute("write", "admin")).toBe("allow");
    });

    test("admin can execute dynamic tools without approval", () => {
      expect(canExecute("dynamic", "admin", true)).toBe("allow");
    });
  });
});

import { describe, test, expect } from "bun:test";
import { isWriteTool, canExecute } from "./access.js";

describe("isWriteTool", () => {
  test("gmail_create_draft is a write tool", () => {
    expect(isWriteTool("gmail_create_draft")).toBe(true);
  });

  test("calendar_create is a write tool", () => {
    expect(isWriteTool("calendar_create")).toBe(true);
  });

  test("gmail_search is not a write tool", () => {
    expect(isWriteTool("gmail_search")).toBe(false);
  });

  test("calendar_list is not a write tool", () => {
    expect(isWriteTool("calendar_list")).toBe(false);
  });

  test("drive_list is not a write tool", () => {
    expect(isWriteTool("drive_list")).toBe(false);
  });

  test("empty string is not a write tool", () => {
    expect(isWriteTool("")).toBe(false);
  });

  test("arbitrary string is not a write tool", () => {
    expect(isWriteTool("unknown_tool")).toBe(false);
  });
});

describe("canExecute", () => {
  describe("owner role", () => {
    test("owner can execute read tools", () => {
      expect(canExecute("gmail_search", "owner")).toBe("allow");
    });

    test("owner can execute write tools", () => {
      expect(canExecute("gmail_create_draft", "owner")).toBe("allow");
      expect(canExecute("calendar_create", "owner")).toBe("allow");
    });
  });

  describe("member role", () => {
    test("member can execute read tools", () => {
      expect(canExecute("gmail_search", "member")).toBe("allow");
      expect(canExecute("calendar_list", "member")).toBe("allow");
    });

    test("member needs approval for write tools", () => {
      expect(canExecute("gmail_create_draft", "member")).toBe("needs_approval");
      expect(canExecute("calendar_create", "member")).toBe("needs_approval");
    });
  });
});

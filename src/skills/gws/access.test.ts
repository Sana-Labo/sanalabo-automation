import { describe, test, expect } from "bun:test";
import { isWriteTool, canExecute } from "./access.js";

describe("isWriteTool", () => {
  const writeTools = [
    "gmail_create_draft",
    "gmail_send",
    "gmail_reply",
    "gmail_modify_labels",
    "gmail_trash",
    "calendar_create",
    "calendar_update",
    "calendar_delete",
    "drive_upload",
    "drive_share",
  ];

  for (const tool of writeTools) {
    test(`${tool} is a write tool`, () => {
      expect(isWriteTool(tool)).toBe(true);
    });
  }

  const readTools = [
    "gmail_list",
    "gmail_get",
    "calendar_list",
    "drive_search",
    "drive_get_content",
  ];

  for (const tool of readTools) {
    test(`${tool} is not a write tool`, () => {
      expect(isWriteTool(tool)).toBe(false);
    });
  }

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
      expect(canExecute("gmail_list", "owner")).toBe("allow");
      expect(canExecute("drive_get_content", "owner")).toBe("allow");
    });

    test("owner can execute write tools", () => {
      expect(canExecute("gmail_create_draft", "owner")).toBe("allow");
      expect(canExecute("gmail_send", "owner")).toBe("allow");
      expect(canExecute("calendar_create", "owner")).toBe("allow");
      expect(canExecute("drive_upload", "owner")).toBe("allow");
    });
  });

  describe("member role", () => {
    test("member can execute read tools", () => {
      expect(canExecute("gmail_list", "member")).toBe("allow");
      expect(canExecute("calendar_list", "member")).toBe("allow");
      expect(canExecute("drive_search", "member")).toBe("allow");
      expect(canExecute("drive_get_content", "member")).toBe("allow");
    });

    test("member needs approval for write tools", () => {
      expect(canExecute("gmail_create_draft", "member")).toBe("needs_approval");
      expect(canExecute("gmail_send", "member")).toBe("needs_approval");
      expect(canExecute("gmail_reply", "member")).toBe("needs_approval");
      expect(canExecute("gmail_modify_labels", "member")).toBe("needs_approval");
      expect(canExecute("gmail_trash", "member")).toBe("needs_approval");
      expect(canExecute("calendar_create", "member")).toBe("needs_approval");
      expect(canExecute("calendar_update", "member")).toBe("needs_approval");
      expect(canExecute("calendar_delete", "member")).toBe("needs_approval");
      expect(canExecute("drive_upload", "member")).toBe("needs_approval");
      expect(canExecute("drive_share", "member")).toBe("needs_approval");
    });
  });

  describe("admin role", () => {
    test("admin can execute read tools", () => {
      expect(canExecute("gmail_list", "admin")).toBe("allow");
    });

    test("admin can execute write tools without approval", () => {
      expect(canExecute("gmail_send", "admin")).toBe("allow");
      expect(canExecute("calendar_delete", "admin")).toBe("allow");
      expect(canExecute("drive_share", "admin")).toBe("allow");
    });
  });
});

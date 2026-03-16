import { describe, test, expect, afterEach } from "bun:test";
import { createGwsExecutors, getGwsExecutors, invalidateGwsExecutors } from "./executor.js";

const EXPECTED_TOOLS = [
  "gmail_list",
  "gmail_get",
  "gmail_create_draft",
  "calendar_list",
  "calendar_create",
  "drive_search",
];

afterEach(() => {
  // Clean up executor cache between tests to avoid cross-test state leaks
  invalidateGwsExecutors("ws_test_1");
  invalidateGwsExecutors("ws_test_2");
});

describe("createGwsExecutors", () => {
  test("returns Map with 6 executors", () => {
    const executors = createGwsExecutors({ configDir: "/tmp/gws-config" });

    expect(executors).toBeInstanceOf(Map);
    expect(executors.size).toBe(6);

    for (const name of EXPECTED_TOOLS) {
      expect(executors.has(name)).toBe(true);
      expect(typeof executors.get(name)).toBe("function");
    }
  });
});

describe("getGwsExecutors", () => {
  test("first call creates and returns a new Map", () => {
    const executors = getGwsExecutors("ws_test_1", "/tmp/gws-config-1");

    expect(executors).toBeInstanceOf(Map);
    expect(executors.size).toBe(6);
  });

  test("second call with same workspaceId returns the same reference (cache hit)", () => {
    const first = getGwsExecutors("ws_test_1", "/tmp/gws-config-1");
    const second = getGwsExecutors("ws_test_1", "/tmp/gws-config-1");

    expect(second).toBe(first); // referential equality
  });

  test("different workspaceId returns a different Map", () => {
    const map1 = getGwsExecutors("ws_test_1", "/tmp/gws-config-1");
    const map2 = getGwsExecutors("ws_test_2", "/tmp/gws-config-2");

    expect(map2).not.toBe(map1);
  });
});

describe("invalidateGwsExecutors", () => {
  test("invalidated cache produces a new Map on next call", () => {
    const first = getGwsExecutors("ws_test_1", "/tmp/gws-config-1");
    invalidateGwsExecutors("ws_test_1");
    const second = getGwsExecutors("ws_test_1", "/tmp/gws-config-1");

    expect(second).not.toBe(first);
    expect(second.size).toBe(6);
  });
});

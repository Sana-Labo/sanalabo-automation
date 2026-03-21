import { describe, test, expect } from "bun:test";
import { createPendingAuth, consumePendingAuth, cleanupExpiredAuths } from "./oauth-state.js";

describe("oauth-state", () => {
  test("createPendingAuth → consumePendingAuth 라운드트립", () => {
    const state = createPendingAuth("U001", "ws-1");
    expect(typeof state).toBe("string");
    expect(state.length).toBeGreaterThan(0);

    const auth = consumePendingAuth(state);
    expect(auth).not.toBeNull();
    expect(auth!.userId).toBe("U001");
    expect(auth!.workspaceId).toBe("ws-1");
  });

  test("동일 state 재소비 → null (1회성)", () => {
    const state = createPendingAuth("U001", "ws-1");
    consumePendingAuth(state);
    expect(consumePendingAuth(state)).toBeNull();
  });

  test("존재하지 않는 state → null", () => {
    expect(consumePendingAuth("nonexistent")).toBeNull();
  });

  test("cleanupExpiredAuths: 만료되지 않은 항목은 유지", () => {
    createPendingAuth("U001", "ws-1");
    const cleaned = cleanupExpiredAuths();
    expect(cleaned).toBe(0);
  });
});

import { describe, test, expect, beforeEach } from "bun:test";
import {
  createPendingAuth,
  consumePendingAuth,
  cleanupExpiredAuths,
  _resetForTest,
} from "./oauth-state.js";

describe("oauth-state", () => {
  beforeEach(() => {
    _resetForTest();
  });

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

  test("만료된 state 소비 → null", () => {
    const state = createPendingAuth("U001", "ws-1");

    // 11분 후로 시간 이동 (TTL 10분)
    const realNow = Date.now;
    Date.now = () => realNow() + 11 * 60 * 1000;
    try {
      expect(consumePendingAuth(state)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  test("cleanupExpiredAuths: 만료되지 않은 항목은 유지", () => {
    const state = createPendingAuth("U001", "ws-1");
    const cleaned = cleanupExpiredAuths();
    expect(cleaned).toBe(0);

    // 정리 후에도 소비 가능
    expect(consumePendingAuth(state)).not.toBeNull();
  });

  test("cleanupExpiredAuths: 만료된 항목 삭제", () => {
    const state = createPendingAuth("U001", "ws-1");
    createPendingAuth("U002", "ws-2"); // 미만료 항목

    // 11분 후로 시간 이동
    const realNow = Date.now;
    const futureTime = realNow() + 11 * 60 * 1000;
    Date.now = () => futureTime;
    try {
      const cleaned = cleanupExpiredAuths();
      // 두 항목 모두 10분 TTL이므로 11분 후에는 모두 만료
      expect(cleaned).toBe(2);

      // 정리된 항목은 소비 불가
      expect(consumePendingAuth(state)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });
});

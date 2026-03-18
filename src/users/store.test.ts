import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import "../test-utils/setup-env.js";
import { createTestDir } from "../test-utils/tmpdir.js";

const { JsonUserStore } = await import("./store.js");

const td = createTestDir("user-store");
let store: InstanceType<typeof JsonUserStore>;

beforeEach(async () => {
  store = new JsonUserStore(td.path("users.json"));
  await store.load();
});

afterEach(() => td.cleanup());

describe("JsonUserStore", () => {
  test("invite: new user gets status 'invited'", async () => {
    await store.invite("Uuser01", "Uowner01");

    expect(store.isInvited("Uuser01")).toBe(true);
    expect(store.isActive("Uuser01")).toBe(false);
  });

  test("activate: invited -> active", async () => {
    await store.invite("Uuser01", "Uowner01");
    await store.activate("Uuser01");

    expect(store.isActive("Uuser01")).toBe(true);
    expect(store.isInvited("Uuser01")).toBe(false);
  });

  test("deactivate: active -> inactive", async () => {
    await store.invite("Uuser01", "Uowner01");
    await store.activate("Uuser01");
    await store.deactivate("Uuser01");

    expect(store.isActive("Uuser01")).toBe(false);
    expect(store.isInvited("Uuser01")).toBe(false);
  });

  test("isActive: only active users return true", async () => {
    await store.invite("Uuser01", "Uowner01");
    expect(store.isActive("Uuser01")).toBe(false); // invited

    await store.activate("Uuser01");
    expect(store.isActive("Uuser01")).toBe(true); // active

    await store.deactivate("Uuser01");
    expect(store.isActive("Uuser01")).toBe(false); // inactive

    expect(store.isActive("Unonexistent")).toBe(false); // unknown
  });

  test("isInvited: only invited users return true", async () => {
    await store.invite("Uuser01", "Uowner01");
    expect(store.isInvited("Uuser01")).toBe(true);

    await store.activate("Uuser01");
    expect(store.isInvited("Uuser01")).toBe(false);

    expect(store.isInvited("Unonexistent")).toBe(false);
  });

  test("getActiveUsers: returns only active user IDs", async () => {
    await store.invite("Uuser01", "Uowner01");
    await store.invite("Uuser02", "Uowner01");
    await store.invite("Uuser03", "Uowner01");

    await store.activate("Uuser01");
    await store.activate("Uuser03");

    const activeUsers = store.getActiveUsers();
    expect(activeUsers).toContain("Uuser01");
    expect(activeUsers).toContain("Uuser03");
    expect(activeUsers).not.toContain("Uuser02");
  });

  test("setDefaultWorkspaceId: sets and retrieves workspace ID", async () => {
    await store.invite("Uuser01", "Uowner01");
    await store.activate("Uuser01");

    expect(store.getDefaultWorkspaceId("Uuser01")).toBeUndefined();

    await store.setDefaultWorkspaceId("Uuser01", "ws-001");
    expect(store.getDefaultWorkspaceId("Uuser01")).toBe("ws-001");
  });

  test("setDefaultWorkspaceId: no-op for nonexistent user", async () => {
    // 에러 발생하지 않아야 함
    await store.setDefaultWorkspaceId("Unonexistent", "ws-001");
    expect(store.getDefaultWorkspaceId("Unonexistent")).toBeUndefined();
  });

  test("invite duplicate: already active user is no-op", async () => {
    await store.invite("Uuser01", "Uowner01");
    await store.activate("Uuser01");

    // 재초대는 무처리
    await store.invite("Uuser01", "Uowner02");
    expect(store.isActive("Uuser01")).toBe(true);
  });

  test("isSystemAdmin: returns true for configured admin IDs", () => {
    expect(store.isSystemAdmin("Uadmin00000000000000000000000001")).toBe(true);
    expect(store.isSystemAdmin("Uuser01")).toBe(false);
  });

  test("registerSystemAdmins: admin is auto-registered as active", async () => {
    await store.registerSystemAdmins();

    expect(store.isActive("Uadmin00000000000000000000000001")).toBe(true);
  });

  test("activate: no-op for nonexistent user", async () => {
    // 에러 발생하지 않아야 함
    await store.activate("Unonexistent");
    expect(store.isActive("Unonexistent")).toBe(false);
  });

  test("deactivate: no-op for non-active user", async () => {
    await store.invite("Uuser01", "Uowner01");
    // invited 상태, active 아님 — deactivate는 무처리
    await store.deactivate("Uuser01");
    expect(store.isInvited("Uuser01")).toBe(true);
  });
});

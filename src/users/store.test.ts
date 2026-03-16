import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { join } from "node:path";

// Set environment variables before importing modules that depend on config
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-token";
process.env.LINE_CHANNEL_SECRET = "test-secret";
process.env.SYSTEM_ADMIN_IDS = "Uadmin00000000000000000000000001";

const { JsonUserStore } = await import("./store.js");

const testDir = join(tmpdir(), `user-store-test-${crypto.randomUUID()}`);
let testCounter = 0;

function testPath(): string {
  return join(testDir, `store-${++testCounter}`, "users.json");
}

let store: InstanceType<typeof JsonUserStore>;

beforeEach(async () => {
  store = new JsonUserStore(testPath());
  await store.load();
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  testCounter = 0;
});

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
    // Should not throw
    await store.setDefaultWorkspaceId("Unonexistent", "ws-001");
    expect(store.getDefaultWorkspaceId("Unonexistent")).toBeUndefined();
  });

  test("invite duplicate: already active user is no-op", async () => {
    await store.invite("Uuser01", "Uowner01");
    await store.activate("Uuser01");

    // Re-invite should be a no-op
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
    // Should not throw
    await store.activate("Unonexistent");
    expect(store.isActive("Unonexistent")).toBe(false);
  });

  test("deactivate: no-op for non-active user", async () => {
    await store.invite("Uuser01", "Uowner01");
    // User is invited, not active — deactivate should be no-op
    await store.deactivate("Uuser01");
    expect(store.isInvited("Uuser01")).toBe(true);
  });
});

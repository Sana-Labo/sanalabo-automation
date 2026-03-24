import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import "../test-utils/setup-env.js";
import { createTestDir } from "../test-utils/tmpdir.js";
import { createFromFollow, deactivate } from "../domain/user.js";

const { JsonUserStore } = await import("./store.js");

const td = createTestDir("user-store");
let store: InstanceType<typeof JsonUserStore>;

beforeEach(async () => {
  store = new JsonUserStore(td.path("users.json"));
  await store.load();
});

afterEach(() => td.cleanup());

describe("JsonUserStore", () => {
  // --- get / set ---

  test("get: returns undefined for nonexistent user", () => {
    expect(store.get("Unonexistent")).toBeUndefined();
  });

  test("set: stores and retrieves a record", async () => {
    const record = createFromFollow();
    await store.set("Uuser01", record);

    expect(store.get("Uuser01")).toEqual(record);
  });

  test("set: overwrites existing record", async () => {
    await store.set("Uuser01", createFromFollow());
    const deactivated = deactivate(store.get("Uuser01")!);
    await store.set("Uuser01", deactivated);

    expect(store.get("Uuser01")?.status).toBe("inactive");
  });

  // --- getActiveUsers ---

  test("getActiveUsers: returns only active user IDs", async () => {
    await store.set("Uuser01", createFromFollow());
    await store.set("Uuser02", createFromFollow());
    await store.set("Uuser03", createFromFollow());

    // Uuser02 를 비활성화
    await store.set("Uuser02", deactivate(store.get("Uuser02")!));

    const activeUsers = store.getActiveUsers();
    expect(activeUsers).toContain("Uuser01");
    expect(activeUsers).toContain("Uuser03");
    expect(activeUsers).not.toContain("Uuser02");
  });

  // --- lastWorkspaceId ---

  test("setLastWorkspaceId: sets and retrieves workspace ID", async () => {
    await store.set("Uuser01", createFromFollow());

    expect(store.getLastWorkspaceId("Uuser01")).toBeUndefined();

    await store.setLastWorkspaceId("Uuser01", "ws-001");
    expect(store.getLastWorkspaceId("Uuser01")).toBe("ws-001");
  });

  test("setLastWorkspaceId: no-op for nonexistent user", async () => {
    await store.setLastWorkspaceId("Unonexistent", "ws-001");
    expect(store.getLastWorkspaceId("Unonexistent")).toBeUndefined();
  });

  // --- clearLastWorkspaceId ---

  test("clearLastWorkspaceId: clears previously set workspace ID", async () => {
    await store.set("Uuser01", createFromFollow());
    await store.setLastWorkspaceId("Uuser01", "ws-001");
    expect(store.getLastWorkspaceId("Uuser01")).toBe("ws-001");

    await store.clearLastWorkspaceId("Uuser01");
    expect(store.getLastWorkspaceId("Uuser01")).toBeUndefined();
  });

  test("clearLastWorkspaceId: no-op for nonexistent user", async () => {
    await store.clearLastWorkspaceId("Unonexistent");
    expect(store.getLastWorkspaceId("Unonexistent")).toBeUndefined();
  });

  // --- isSystemAdmin ---

  test("isSystemAdmin: returns true for configured admin IDs", () => {
    expect(store.isSystemAdmin("Uadmin00000000000000000000000001")).toBe(true);
    expect(store.isSystemAdmin("Uuser01")).toBe(false);
  });

  // --- registerSystemAdmins ---

  test("registerSystemAdmins: admin is auto-registered as active", async () => {
    await store.registerSystemAdmins();

    const admin = store.get("Uadmin00000000000000000000000001");
    expect(admin?.status).toBe("active");
    expect(admin?.invitedBy).toBe("system");
  });
});

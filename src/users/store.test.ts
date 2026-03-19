import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import "../test-utils/setup-env.js";
import { createTestDir } from "../test-utils/tmpdir.js";
import { activate } from "../domain/user.js";

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
    const record = { status: "active" as const, invitedBy: "self" as const, invitedAt: "2024-01-01T00:00:00Z", activatedAt: "2024-01-01T00:00:00Z" };
    await store.set("Uuser01", record);

    expect(store.get("Uuser01")).toEqual(record);
  });

  test("set: overwrites existing record", async () => {
    await store.set("Uuser01", { status: "invited", invitedBy: "Uowner01", invitedAt: "2024-01-01T00:00:00Z" });
    const updated = { status: "active" as const, invitedBy: "Uowner01" as const, invitedAt: "2024-01-01T00:00:00Z", activatedAt: "2024-01-02T00:00:00Z" };
    await store.set("Uuser01", updated);

    expect(store.get("Uuser01")).toEqual(updated);
  });

  // --- invite ---

  test("invite: new user gets status 'invited'", async () => {
    await store.invite("Uuser01", "Uowner01");

    const record = store.get("Uuser01");
    expect(record?.status).toBe("invited");
    expect(record?.invitedBy).toBe("Uowner01");
  });

  test("invite: already active user is no-op", async () => {
    await store.set("Uuser01", { status: "active", invitedBy: "Uowner01", invitedAt: "2024-01-01T00:00:00Z", activatedAt: "2024-01-01T00:00:00Z" });

    await store.invite("Uuser01", "Uowner02");
    expect(store.get("Uuser01")?.status).toBe("active");
    expect(store.get("Uuser01")?.invitedBy).toBe("Uowner01"); // 원본 유지
  });

  // --- getActiveUsers ---

  test("getActiveUsers: returns only active user IDs", async () => {
    await store.invite("Uuser01", "Uowner01");
    await store.invite("Uuser02", "Uowner01");
    await store.invite("Uuser03", "Uowner01");

    // domain 함수로 activate
    const r1 = store.get("Uuser01")!;
    await store.set("Uuser01", activate(r1));
    const r3 = store.get("Uuser03")!;
    await store.set("Uuser03", activate(r3));

    const activeUsers = store.getActiveUsers();
    expect(activeUsers).toContain("Uuser01");
    expect(activeUsers).toContain("Uuser03");
    expect(activeUsers).not.toContain("Uuser02");
  });

  // --- defaultWorkspaceId ---

  test("setDefaultWorkspaceId: sets and retrieves workspace ID", async () => {
    await store.set("Uuser01", { status: "active", invitedBy: "self", invitedAt: "2024-01-01T00:00:00Z", activatedAt: "2024-01-01T00:00:00Z" });

    expect(store.getDefaultWorkspaceId("Uuser01")).toBeUndefined();

    await store.setDefaultWorkspaceId("Uuser01", "ws-001");
    expect(store.getDefaultWorkspaceId("Uuser01")).toBe("ws-001");
  });

  test("setDefaultWorkspaceId: no-op for nonexistent user", async () => {
    await store.setDefaultWorkspaceId("Unonexistent", "ws-001");
    expect(store.getDefaultWorkspaceId("Unonexistent")).toBeUndefined();
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

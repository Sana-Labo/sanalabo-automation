import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { join } from "node:path";

// Set environment variables before importing modules that depend on config
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-token";
process.env.LINE_CHANNEL_SECRET = "test-secret";
process.env.SYSTEM_ADMIN_IDS = "Uadmin00000000000000000000000001";

const { JsonWorkspaceStore } = await import("./store.js");

const testDir = join(tmpdir(), `workspace-store-test-${crypto.randomUUID()}`);
let testCounter = 0;

function testPaths(): { storePath: string; dataDir: string } {
  const id = ++testCounter;
  return {
    storePath: join(testDir, `instance-${id}`, "workspaces.json"),
    dataDir: join(testDir, `instance-${id}`, "workspaces"),
  };
}

let store: InstanceType<typeof JsonWorkspaceStore>;
let paths: ReturnType<typeof testPaths>;

beforeEach(async () => {
  paths = testPaths();
  store = new JsonWorkspaceStore(paths.storePath, paths.dataDir);
  await store.load();
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  testCounter = 0;
});

describe("JsonWorkspaceStore", () => {
  test("create: workspace has id, name, ownerId, gwsConfigDir", async () => {
    const ws = await store.create("Test WS", "Uowner01");

    expect(ws.id).toBeString();
    expect(ws.id.length).toBe(12);
    expect(ws.name).toBe("Test WS");
    expect(ws.ownerId).toBe("Uowner01");
    expect(ws.gwsConfigDir).toContain(ws.id);
    expect(ws.gwsAuthenticated).toBe(false);
    expect(ws.members["Uowner01"]).toBeDefined();
    expect(ws.members["Uowner01"]!.role).toBe("owner");
  });

  test("get: retrieve by ID", async () => {
    const created = await store.create("WS1", "Uowner01");
    const retrieved = store.get(created.id);

    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe("WS1");
  });

  test("get: nonexistent ID returns undefined", () => {
    expect(store.get("nonexistent")).toBeUndefined();
  });

  test("getAll: returns all workspaces", async () => {
    await store.create("WS1", "Uowner01");
    await store.create("WS2", "Uowner02");

    const all = store.getAll();
    expect(all.length).toBe(2);
  });

  test("getByOwner: filters by owner", async () => {
    await store.create("WS1", "Uowner01");
    await store.create("WS2", "Uowner01");
    await store.create("WS3", "Uowner02");

    const ownerWorkspaces = store.getByOwner("Uowner01");
    expect(ownerWorkspaces.length).toBe(2);
    expect(ownerWorkspaces.every((ws) => ws.ownerId === "Uowner01")).toBe(true);
  });

  test("getByMember: returns workspaces where user is a member", async () => {
    const ws1 = await store.create("WS1", "Uowner01");
    await store.create("WS2", "Uowner02");
    await store.inviteMember(ws1.id, "Umember01", "Uowner01");

    // Umember01 is in WS1
    const memberWorkspaces = store.getByMember("Umember01");
    expect(memberWorkspaces.length).toBe(1);
    expect(memberWorkspaces[0]!.id).toBe(ws1.id);

    // Uowner01 is also a member (as owner)
    const ownerWorkspaces = store.getByMember("Uowner01");
    expect(ownerWorkspaces.length).toBe(1);
    expect(ownerWorkspaces[0]!.id).toBe(ws1.id);
  });

  test("inviteMember: adds member to workspace", async () => {
    const ws = await store.create("WS1", "Uowner01");
    await store.inviteMember(ws.id, "Umember01", "Uowner01");

    const updated = store.get(ws.id)!;
    expect(updated.members["Umember01"]).toBeDefined();
    expect(updated.members["Umember01"]!.role).toBe("member");
  });

  test("inviteMember: already a member is no-op", async () => {
    const ws = await store.create("WS1", "Uowner01");
    await store.inviteMember(ws.id, "Umember01", "Uowner01");
    await store.inviteMember(ws.id, "Umember01", "Uother"); // no-op

    const updated = store.get(ws.id)!;
    // invitedBy should remain the original
    expect(updated.members["Umember01"]!.invitedBy).toBe("Uowner01");
  });

  test("inviteMember: nonexistent workspace throws", async () => {
    expect(
      store.inviteMember("nonexistent", "Umember01", "Uowner01"),
    ).rejects.toThrow("Workspace not found");
  });

  test("removeMember: removes member from workspace", async () => {
    const ws = await store.create("WS1", "Uowner01");
    await store.inviteMember(ws.id, "Umember01", "Uowner01");
    await store.removeMember(ws.id, "Umember01");

    const updated = store.get(ws.id)!;
    expect(updated.members["Umember01"]).toBeUndefined();
  });

  test("removeMember: removing owner throws", async () => {
    const ws = await store.create("WS1", "Uowner01");

    expect(store.removeMember(ws.id, "Uowner01")).rejects.toThrow(
      "Cannot remove workspace owner",
    );
  });

  test("removeMember: nonexistent workspace throws", async () => {
    expect(store.removeMember("nonexistent", "Umember01")).rejects.toThrow(
      "Workspace not found",
    );
  });

  test("resolveWorkspace: single membership auto-resolves", async () => {
    const ws = await store.create("WS1", "Uowner01");

    const resolved = store.resolveWorkspace("Uowner01");
    expect(resolved).toBeDefined();
    expect(resolved!.id).toBe(ws.id);
  });

  test("resolveWorkspace: no membership returns undefined", () => {
    const resolved = store.resolveWorkspace("Uunknown");
    expect(resolved).toBeUndefined();
  });

  test("resolveWorkspace: multiple memberships with defaultWorkspaceId", async () => {
    const ws1 = await store.create("WS1", "Uowner01");
    const ws2 = await store.create("WS2", "Uowner02");
    await store.inviteMember(ws2.id, "Uowner01", "Uowner02");

    // Without default — returns undefined
    const noDefault = store.resolveWorkspace("Uowner01");
    expect(noDefault).toBeUndefined();

    // With default — returns specified workspace
    const withDefault = store.resolveWorkspace("Uowner01", ws2.id);
    expect(withDefault).toBeDefined();
    expect(withDefault!.id).toBe(ws2.id);
  });

  test("getUserRole: returns correct role", async () => {
    const ws = await store.create("WS1", "Uowner01");
    await store.inviteMember(ws.id, "Umember01", "Uowner01");

    expect(store.getUserRole(ws.id, "Uowner01")).toBe("owner");
    expect(store.getUserRole(ws.id, "Umember01")).toBe("member");
  });

  test("getUserRole: nonexistent user/workspace returns undefined", async () => {
    const ws = await store.create("WS1", "Uowner01");

    expect(store.getUserRole(ws.id, "Uunknown")).toBeUndefined();
    expect(store.getUserRole("nonexistent", "Uowner01")).toBeUndefined();
  });

  test("setGwsAuthenticated: updates flag", async () => {
    const ws = await store.create("WS1", "Uowner01");
    expect(store.get(ws.id)!.gwsAuthenticated).toBe(false);

    await store.setGwsAuthenticated(ws.id, true);
    expect(store.get(ws.id)!.gwsAuthenticated).toBe(true);

    await store.setGwsAuthenticated(ws.id, false);
    expect(store.get(ws.id)!.gwsAuthenticated).toBe(false);
  });

  test("setGwsAuthenticated: nonexistent workspace throws", async () => {
    expect(store.setGwsAuthenticated("nonexistent", true)).rejects.toThrow(
      "Workspace not found",
    );
  });

  test("persistence: data survives reload", async () => {
    const ws = await store.create("WS1", "Uowner01");
    await store.inviteMember(ws.id, "Umember01", "Uowner01");

    // Reload into fresh instance
    const store2 = new JsonWorkspaceStore(paths.storePath, paths.dataDir);
    await store2.load();

    const reloaded = store2.get(ws.id);
    expect(reloaded).toBeDefined();
    expect(reloaded!.name).toBe("WS1");
    expect(reloaded!.members["Umember01"]).toBeDefined();
  });
});

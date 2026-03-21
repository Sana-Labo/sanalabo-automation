import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import "../test-utils/setup-env.js";
import { createTestDir } from "../test-utils/tmpdir.js";

const { JsonWorkspaceStore } = await import("./store.js");

const td = createTestDir("workspace-store");
let store: InstanceType<typeof JsonWorkspaceStore>;

beforeEach(async () => {
  const base = td.path();
  store = new JsonWorkspaceStore(`${base}/workspaces.json`, `${base}/workspaces`);
  await store.load();
});

afterEach(() => td.cleanup());

describe("JsonWorkspaceStore", () => {
  test("create: workspace has id, name, ownerId, gwsAuthenticated", async () => {
    const ws = await store.create("Test WS", "Uowner01");

    expect(ws.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(ws.name).toBe("Test WS");
    expect(ws.ownerId).toBe("Uowner01");
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

    // Umember01은 WS1에 소속
    const memberWorkspaces = store.getByMember("Umember01");
    expect(memberWorkspaces.length).toBe(1);
    expect(memberWorkspaces[0]!.id).toBe(ws1.id);

    // Uowner01도 멤버 (오너로서)
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
    // invitedBy는 원래 값을 유지해야 함
    expect(updated.members["Umember01"]!.invitedBy).toBe("Uowner01");
  });

  test("inviteMember: nonexistent workspace throws", async () => {
    await expect(
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

    await expect(store.removeMember(ws.id, "Uowner01")).rejects.toThrow(
      "Cannot remove workspace owner",
    );
  });

  test("removeMember: nonexistent workspace throws", async () => {
    await expect(store.removeMember("nonexistent", "Umember01")).rejects.toThrow(
      "Workspace not found",
    );
  });

  test("resolveWorkspace: 단일 소속이라도 lastWorkspaceId 없으면 undefined", async () => {
    await store.create("WS1", "Uowner01");

    const resolved = store.resolveWorkspace("Uowner01");
    expect(resolved).toBeUndefined();
  });

  test("resolveWorkspace: 단일 소속 + lastWorkspaceId 매칭 시 반환", async () => {
    const ws = await store.create("WS1", "Uowner01");

    const resolved = store.resolveWorkspace("Uowner01", ws.id);
    expect(resolved).toBeDefined();
    expect(resolved!.id).toBe(ws.id);
  });

  test("resolveWorkspace: no membership returns undefined", () => {
    const resolved = store.resolveWorkspace("Uunknown");
    expect(resolved).toBeUndefined();
  });

  test("resolveWorkspace: 복수 소속 + lastWorkspaceId 매칭", async () => {
    await store.create("WS1", "Uowner01");
    const ws2 = await store.create("WS2", "Uowner02");
    await store.inviteMember(ws2.id, "Uowner01", "Uowner02");

    // lastWorkspaceId 없음 → undefined
    const noLast = store.resolveWorkspace("Uowner01");
    expect(noLast).toBeUndefined();

    // lastWorkspaceId 매칭 → 해당 워크스페이스 반환
    const withLast = store.resolveWorkspace("Uowner01", ws2.id);
    expect(withLast).toBeDefined();
    expect(withLast!.id).toBe(ws2.id);
  });

  test("resolveWorkspace: lastWorkspaceId가 미소속 WS를 가리키면 undefined", async () => {
    await store.create("WS1", "Uowner01");

    const resolved = store.resolveWorkspace("Uowner01", "nonexistent-ws-id");
    expect(resolved).toBeUndefined();
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
    await expect(store.setGwsAuthenticated("nonexistent", true)).rejects.toThrow(
      "Workspace not found",
    );
  });

  test("persistence: data survives reload", async () => {
    const base = td.path();
    const storePath = `${base}/workspaces.json`;
    const dataDir = `${base}/workspaces`;

    const store1 = new JsonWorkspaceStore(storePath, dataDir);
    await store1.load();
    const ws = await store1.create("WS1", "Uowner01");
    await store1.inviteMember(ws.id, "Umember01", "Uowner01");

    // 새 인스턴스로 재로드
    const store2 = new JsonWorkspaceStore(storePath, dataDir);
    await store2.load();

    const reloaded = store2.get(ws.id);
    expect(reloaded).toBeDefined();
    expect(reloaded!.name).toBe("WS1");
    expect(reloaded!.members["Umember01"]).toBeDefined();
  });
});

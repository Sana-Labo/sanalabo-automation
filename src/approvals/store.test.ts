import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { join } from "node:path";

// Set environment variables before importing modules that depend on config
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-token";
process.env.LINE_CHANNEL_SECRET = "test-secret";
process.env.SYSTEM_ADMIN_IDS = "Uadmin00000000000000000000000001";

const { JsonPendingActionStore } = await import("./store.js");

const testDir = join(tmpdir(), `approval-store-test-${crypto.randomUUID()}`);
let testCounter = 0;

function testPath(): string {
  return join(testDir, `store-${++testCounter}`, "pending-actions.json");
}

let store: InstanceType<typeof JsonPendingActionStore>;

const sampleAction = {
  workspaceId: "ws-001",
  requesterId: "Uuser01",
  toolName: "gmail_send_draft",
  toolInput: { to: "test@example.com", subject: "Hello" },
  requestContext: "User asked to send email",
};

beforeEach(async () => {
  store = new JsonPendingActionStore(testPath());
  await store.load();
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  testCounter = 0;
});

describe("JsonPendingActionStore", () => {
  test("create: pending action gets status 'pending'", async () => {
    const action = await store.create(sampleAction);

    expect(action.id).toBeString();
    expect(action.id.length).toBe(12);
    expect(action.status).toBe("pending");
    expect(action.workspaceId).toBe("ws-001");
    expect(action.requesterId).toBe("Uuser01");
    expect(action.toolName).toBe("gmail_send_draft");
    expect(action.createdAt).toBeString();
  });

  test("get: retrieve by ID", async () => {
    const created = await store.create(sampleAction);
    const retrieved = store.get(created.id);

    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(created.id);
    expect(retrieved!.toolName).toBe("gmail_send_draft");
  });

  test("get: nonexistent ID returns undefined", () => {
    expect(store.get("nonexistent")).toBeUndefined();
  });

  test("getByWorkspace: filters by workspace ID", async () => {
    await store.create(sampleAction);
    await store.create({ ...sampleAction, workspaceId: "ws-002" });
    await store.create(sampleAction);

    const ws1Actions = store.getByWorkspace("ws-001");
    expect(ws1Actions.length).toBe(2);

    const ws2Actions = store.getByWorkspace("ws-002");
    expect(ws2Actions.length).toBe(1);
  });

  test("getByWorkspace: filters by status", async () => {
    const action1 = await store.create(sampleAction);
    await store.create(sampleAction);
    await store.approve(action1.id, "Uowner01");

    const pending = store.getByWorkspace("ws-001", "pending");
    expect(pending.length).toBe(1);

    const approved = store.getByWorkspace("ws-001", "approved");
    expect(approved.length).toBe(1);
  });

  test("approve: pending -> approved with resolvedBy and resolvedAt", async () => {
    const action = await store.create(sampleAction);
    const approved = await store.approve(action.id, "Uowner01");

    expect(approved.status).toBe("approved");
    expect(approved.resolvedBy).toBe("Uowner01");
    expect(approved.resolvedAt).toBeString();
  });

  test("reject: pending -> rejected with reason", async () => {
    const action = await store.create(sampleAction);
    const rejected = await store.reject(action.id, "Uowner01", "Not appropriate");

    expect(rejected.status).toBe("rejected");
    expect(rejected.resolvedBy).toBe("Uowner01");
    expect(rejected.resolvedAt).toBeString();
    expect(rejected.rejectionReason).toBe("Not appropriate");
  });

  test("reject: without reason", async () => {
    const action = await store.create(sampleAction);
    const rejected = await store.reject(action.id, "Uowner01");

    expect(rejected.status).toBe("rejected");
    expect(rejected.rejectionReason).toBeUndefined();
  });

  test("approve: already resolved throws", async () => {
    const action = await store.create(sampleAction);
    await store.approve(action.id, "Uowner01");

    expect(store.approve(action.id, "Uowner02")).rejects.toThrow(
      "already approved",
    );
  });

  test("reject: already resolved throws", async () => {
    const action = await store.create(sampleAction);
    await store.reject(action.id, "Uowner01");

    expect(store.reject(action.id, "Uowner02")).rejects.toThrow(
      "already rejected",
    );
  });

  test("approve: nonexistent action throws", async () => {
    expect(store.approve("nonexistent", "Uowner01")).rejects.toThrow(
      "Pending action not found",
    );
  });

  test("reject: nonexistent action throws", async () => {
    expect(store.reject("nonexistent", "Uowner01")).rejects.toThrow(
      "Pending action not found",
    );
  });

  test("expireOlderThan: expires pending actions older than threshold", async () => {
    const action = await store.create(sampleAction);

    // Manually backdate createdAt to 25 hours ago
    const actionRecord = store.get(action.id)!;
    actionRecord.createdAt = new Date(
      Date.now() - 25 * 60 * 60 * 1000,
    ).toISOString();

    const expired = await store.expireOlderThan(24);
    expect(expired).toBe(1);

    const updated = store.get(action.id)!;
    expect(updated.status).toBe("expired");
    expect(updated.resolvedAt).toBeString();
  });

  test("expireOlderThan: does not expire recent actions", async () => {
    await store.create(sampleAction);

    const expired = await store.expireOlderThan(24);
    expect(expired).toBe(0);
  });

  test("expireOlderThan: does not expire already resolved actions", async () => {
    const action = await store.create(sampleAction);
    await store.approve(action.id, "Uowner01");

    // Backdate
    const actionRecord = store.get(action.id)!;
    actionRecord.createdAt = new Date(
      Date.now() - 25 * 60 * 60 * 1000,
    ).toISOString();

    const expired = await store.expireOlderThan(24);
    expect(expired).toBe(0);
  });

  test("purgeResolved: removes old resolved actions", async () => {
    const action = await store.create(sampleAction);
    await store.approve(action.id, "Uowner01");

    // Backdate resolvedAt to 8 days ago
    const actionRecord = store.get(action.id)!;
    actionRecord.resolvedAt = new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const purged = await store.purgeResolved(7);
    expect(purged).toBe(1);
    expect(store.get(action.id)).toBeUndefined();
  });

  test("purgeResolved: does not purge recent resolved actions", async () => {
    const action = await store.create(sampleAction);
    await store.approve(action.id, "Uowner01");

    const purged = await store.purgeResolved(7);
    expect(purged).toBe(0);
    expect(store.get(action.id)).toBeDefined();
  });

  test("purgeResolved: does not purge pending actions", async () => {
    await store.create(sampleAction);

    const purged = await store.purgeResolved(0);
    expect(purged).toBe(0);
  });

  test("persistence: data survives reload", async () => {
    const path = join(testDir, "persist-test", "pending-actions.json");
    const store1 = new JsonPendingActionStore(path);
    await store1.load();
    const action = await store1.create(sampleAction);

    const store2 = new JsonPendingActionStore(path);
    await store2.load();

    const reloaded = store2.get(action.id);
    expect(reloaded).toBeDefined();
    expect(reloaded!.status).toBe("pending");
    expect(reloaded!.toolName).toBe("gmail_send_draft");
  });
});

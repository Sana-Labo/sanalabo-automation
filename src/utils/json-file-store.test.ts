import { describe, test, expect, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { JsonFileStore } from "./json-file-store.js";

// Concrete subclass for testing the abstract JsonFileStore
class TestStore extends JsonFileStore<{ value: string }> {
  constructor(path: string) {
    super(path, "test");
  }

  async set(key: string, value: string) {
    this.data[key] = { value };
    await this.save();
  }

  get(key: string) {
    return this.data[key];
  }

  getAll() {
    return { ...this.data };
  }
}

// Unique temp directory per test run
const testDir = join(tmpdir(), `json-file-store-test-${crypto.randomUUID()}`);
let testCounter = 0;

function testPath(): string {
  return join(testDir, `store-${++testCounter}`, "data.json");
}

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  testCounter = 0;
});

describe("JsonFileStore", () => {
  test("load: no file starts with empty state", async () => {
    const store = new TestStore(testPath());
    await store.load();

    expect(store.getAll()).toEqual({});
  });

  test("load: existing file loads data", async () => {
    const path = testPath();
    const existing = { key1: { value: "hello" }, key2: { value: "world" } };

    // Write a valid JSON file first
    const { mkdir: mkdirFs } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdirFs(dirname(path), { recursive: true });
    await Bun.write(Bun.file(path), JSON.stringify(existing, null, 2) + "\n");

    const store = new TestStore(path);
    await store.load();

    expect(store.get("key1")).toEqual({ value: "hello" });
    expect(store.get("key2")).toEqual({ value: "world" });
  });

  test("save + load: roundtrip preserves data", async () => {
    const path = testPath();

    // Save with first instance
    const store1 = new TestStore(path);
    await store1.load();
    await store1.set("a", "alpha");
    await store1.set("b", "bravo");

    // Load with second instance
    const store2 = new TestStore(path);
    await store2.load();

    expect(store2.get("a")).toEqual({ value: "alpha" });
    expect(store2.get("b")).toEqual({ value: "bravo" });
  });

  test("corruption recovery: invalid JSON backs up and starts empty", async () => {
    const path = testPath();

    // Write corrupted JSON
    const { mkdir: mkdirFs } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdirFs(dirname(path), { recursive: true });
    await Bun.write(Bun.file(path), "{invalid json content!!!");

    const store = new TestStore(path);
    await store.load();

    // Store should start empty after corruption
    expect(store.getAll()).toEqual({});

    // .corrupt backup file should exist
    const { readdir } = await import("node:fs/promises");
    const dir = dirname(path);
    const files = await readdir(dir);
    const corruptFiles = files.filter((f) => f.includes(".corrupt."));
    expect(corruptFiles.length).toBeGreaterThanOrEqual(1);
  });

  test("concurrent save: multiple save() calls serialize without data loss", async () => {
    const path = testPath();
    const store = new TestStore(path);
    await store.load();

    // Fire multiple save() calls concurrently
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(store.set(`key${i}`, `value${i}`));
    }
    await Promise.all(promises);

    // All keys should be present
    const all = store.getAll();
    for (let i = 0; i < 10; i++) {
      expect(all[`key${i}`]).toEqual({ value: `value${i}` });
    }

    // Verify persisted data matches
    const store2 = new TestStore(path);
    await store2.load();
    for (let i = 0; i < 10; i++) {
      expect(store2.get(`key${i}`)).toEqual({ value: `value${i}` });
    }
  });

  test("directory auto-creation: nested non-existent path is created", async () => {
    const path = join(testDir, "deep", "nested", "dir", "store.json");
    const store = new TestStore(path);
    await store.load();
    await store.set("x", "y");

    // Verify file was written
    const store2 = new TestStore(path);
    await store2.load();
    expect(store2.get("x")).toEqual({ value: "y" });
  });
});

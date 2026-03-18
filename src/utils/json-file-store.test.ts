import { describe, test, expect, afterEach } from "bun:test";
import { mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { JsonFileStore } from "./json-file-store.js";
import { createTestDir } from "../test-utils/tmpdir.js";

// 추상 클래스 JsonFileStore 테스트용 구현 서브클래스
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

const td = createTestDir("json-file-store");

afterEach(() => td.cleanup());

describe("JsonFileStore", () => {
  test("load: no file starts with empty state", async () => {
    const store = new TestStore(td.path("data.json"));
    await store.load();

    expect(store.getAll()).toEqual({});
  });

  test("load: existing file loads data", async () => {
    const path = td.path("data.json");
    const existing = { key1: { value: "hello" }, key2: { value: "world" } };

    await mkdir(dirname(path), { recursive: true });
    await Bun.write(Bun.file(path), JSON.stringify(existing, null, 2) + "\n");

    const store = new TestStore(path);
    await store.load();

    expect(store.get("key1")).toEqual({ value: "hello" });
    expect(store.get("key2")).toEqual({ value: "world" });
  });

  test("save + load: roundtrip preserves data", async () => {
    const path = td.path("data.json");

    // 첫 번째 인스턴스로 저장
    const store1 = new TestStore(path);
    await store1.load();
    await store1.set("a", "alpha");
    await store1.set("b", "bravo");

    // 두 번째 인스턴스로 로드
    const store2 = new TestStore(path);
    await store2.load();

    expect(store2.get("a")).toEqual({ value: "alpha" });
    expect(store2.get("b")).toEqual({ value: "bravo" });
  });

  test("corruption recovery: invalid JSON backs up and starts empty", async () => {
    const path = td.path("data.json");

    await mkdir(dirname(path), { recursive: true });
    await Bun.write(Bun.file(path), "{invalid json content!!!");

    const store = new TestStore(path);
    await store.load();

    // 손상 후 빈 상태로 시작해야 함
    expect(store.getAll()).toEqual({});

    // .corrupt 백업 파일이 존재해야 함
    const dir = dirname(path);
    const files = await readdir(dir);
    const corruptFiles = files.filter((f) => f.includes(".corrupt."));
    expect(corruptFiles.length).toBeGreaterThanOrEqual(1);
  });

  test("concurrent save: multiple save() calls serialize without data loss", async () => {
    const path = td.path("data.json");
    const store = new TestStore(path);
    await store.load();

    // 다수의 save() 호출을 동시 실행
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(store.set(`key${i}`, `value${i}`));
    }
    await Promise.all(promises);

    // 모든 키가 존재해야 함
    const all = store.getAll();
    for (let i = 0; i < 10; i++) {
      expect(all[`key${i}`]).toEqual({ value: `value${i}` });
    }

    // 영속화된 데이터 일치 확인
    const store2 = new TestStore(path);
    await store2.load();
    for (let i = 0; i < 10; i++) {
      expect(store2.get(`key${i}`)).toEqual({ value: `value${i}` });
    }
  });

  test("directory auto-creation: nested non-existent path is created", async () => {
    const path = join(td.dir, "deep", "nested", "dir", "store.json");
    const store = new TestStore(path);
    await store.load();
    await store.set("x", "y");

    // 파일 기록 확인
    const store2 = new TestStore(path);
    await store2.load();
    expect(store2.get("x")).toEqual({ value: "y" });
  });
});

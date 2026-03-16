import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * JSON file-backed key-value store with atomic writes and corruption recovery.
 * Subclasses define domain logic; infrastructure (load/save/writeLock) lives here.
 */
export abstract class JsonFileStore<T> {
  protected data: Record<string, T> = {};
  private readonly path: string;
  private readonly label: string;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(path: string, label: string) {
    this.path = path;
    this.label = label;
  }

  async load(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });

    try {
      const file = Bun.file(this.path);
      if (await file.exists()) {
        this.data = (await file.json()) as Record<string, T>;
      }
    } catch (e) {
      console.error(`[${this.label}] Failed to load store:`, e);
      try {
        await rename(this.path, `${this.path}.corrupt.${Date.now()}`);
        console.warn(`[${this.label}] Corrupted file backed up`);
      } catch {
        // Backup failed — file may not exist
      }
      this.data = {};
    }
  }

  protected async save(): Promise<void> {
    const prev = this.writeLock;
    let resolve!: () => void;
    this.writeLock = new Promise<void>((r) => {
      resolve = r;
    });
    await prev;
    try {
      const tmp = `${this.path}.tmp.${crypto.randomUUID()}`;
      await Bun.write(Bun.file(tmp), JSON.stringify(this.data, null, 2) + "\n");
      await rename(tmp, this.path);
    } catch (err) {
      console.error(`[${this.label}] Save failed:`, err);
      throw err;
    } finally {
      resolve();
    }
  }
}

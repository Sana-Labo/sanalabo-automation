import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * Creates an isolated temp directory per test file with per-test subdirectories.
 * Usage:
 *   const td = createTestDir("my-store");
 *   beforeEach: td.path("data.json")   // returns unique sub-path per test
 *   afterEach:  td.cleanup()            // removes the entire temp dir
 */
export function createTestDir(prefix: string) {
  const dir = join(tmpdir(), `${prefix}-${crypto.randomUUID()}`);
  let counter = 0;

  return {
    dir,
    path: (...segments: string[]) => join(dir, `test-${++counter}`, ...segments),
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
      counter = 0;
    },
  };
}

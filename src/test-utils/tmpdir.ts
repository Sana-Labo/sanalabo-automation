import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * 테스트 파일별 격리된 임시 디렉터리를 생성한다. 테스트별 서브디렉터리를 제공.
 *
 * - `td.path("data.json")` — beforeEach에서 호출. 테스트별 고유 경로 반환
 * - `td.cleanup()` — afterEach에서 호출. 전체 임시 디렉터리 삭제
 *
 * @param prefix - 임시 디렉터리명 접두사
 * @returns `dir`, `path`, `cleanup`을 포함하는 테스트 디렉터리 헬퍼
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

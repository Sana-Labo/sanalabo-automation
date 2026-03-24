import type { Role } from "../../types.js";
import type { ToolConcurrency } from "../../agent/tool-definition.js";

/**
 * 도구 실행 시 자기 행위에 대한 권한을 판정한다.
 * admin/owner → 즉시 허용, member + write 도구 → 오너 승인 필요.
 *
 * 동시성 속성({@link ToolConcurrency})이 단일 출처:
 * - `read` → 항상 허용
 * - `write` → member는 승인 필요
 * - `dynamic` → isMutating 런타임 판별 결과에 따라 결정
 *
 * 참고: PendingAction 승인 권한과는 별개.
 * 승인은 워크스페이스 오너만 가능 (lineWebhook.ts handleApprovalCommand).
 * admin이라도 해당 워크스페이스의 오너가 아니면 타인의 write를 승인할 수 없음.
 */
export function canExecute(
  concurrency: ToolConcurrency | undefined,
  role: Role,
  isMutating?: boolean,
): "allow" | "needs_approval" {
  if (role === "owner" || role === "admin") return "allow";
  if (concurrency === "write") return "needs_approval";
  if (concurrency === "dynamic" && isMutating) return "needs_approval";
  return "allow";
}

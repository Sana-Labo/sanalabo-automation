import type { Role } from "../../types.js";

// GWS 상태를 변경하며 멤버 사용 시 오너 승인이 필요한 도구.
// 새 도구 추가 시 _create, _update, _delete 접미사를 가진 도구를 포함할 것.
const WRITE_TOOLS = new Set([
  "gmail_create_draft",
  "calendar_create",
]);

export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName);
}

/**
 * 도구 실행 시 자기 행위에 대한 권한을 판정한다.
 * admin/owner → 즉시 허용, member + write 도구 → 오너 승인 필요.
 *
 * 참고: PendingAction 승인 권한과는 별개.
 * 승인은 워크스페이스 오너만 가능 (lineWebhook.ts handleApprovalCommand).
 * admin이라도 해당 워크스페이스의 오너가 아니면 타인의 write를 승인할 수 없음.
 */
export function canExecute(
  toolName: string,
  role: Role,
): "allow" | "needs_approval" {
  if (role === "owner" || role === "admin") return "allow";
  return isWriteTool(toolName) ? "needs_approval" : "allow";
}

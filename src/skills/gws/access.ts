import type { WorkspaceRole } from "../../types.js";

// GWS 상태를 변경하며 멤버 사용 시 오너 승인이 필요한 도구.
// 새 도구 추가 시 _create, _update, _delete 접미사를 가진 도구를 포함할 것.
const WRITE_TOOLS = new Set([
  "gmail_create_draft",
  "calendar_create",
]);

export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName);
}

export function canExecute(
  toolName: string,
  role: WorkspaceRole | "admin",
): "allow" | "needs_approval" {
  if (role === "owner" || role === "admin") return "allow";
  return isWriteTool(toolName) ? "needs_approval" : "allow";
}

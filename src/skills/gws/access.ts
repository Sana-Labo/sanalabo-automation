import type { WorkspaceRole } from "../../types.js";

const WRITE_TOOLS = new Set([
  "gmail_create_draft",
  "calendar_create",
]);

export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName);
}

export function canExecute(
  toolName: string,
  role: WorkspaceRole,
): "allow" | "needs_approval" {
  if (role === "owner") return "allow";
  return isWriteTool(toolName) ? "needs_approval" : "allow";
}

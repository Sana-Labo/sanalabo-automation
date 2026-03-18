import { canExecute } from "../skills/gws/access.js";
import type { PendingAction, PendingActionStore, ToolContext } from "../types.js";

export type InterceptResult =
  | { intercepted: true; pendingAction: PendingAction }
  | { intercepted: false };

export async function interceptWrite(
  toolName: string,
  toolInput: Record<string, unknown>,
  context: ToolContext,
  pendingStore: PendingActionStore,
  requestContext: string,
): Promise<InterceptResult> {
  const decision = canExecute(toolName, context.role);

  if (decision === "allow") {
    return { intercepted: false };
  }

  // needs_approval — PendingAction 생성
  const pendingAction = await pendingStore.create({
    workspaceId: context.workspaceId,
    requesterId: context.userId,
    toolName,
    toolInput,
    requestContext,
  });

  return { intercepted: true, pendingAction };
}

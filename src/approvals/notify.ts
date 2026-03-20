import { LINE_PUSH_FLEX_TOOL, LINE_PUSH_TEXT_TOOL, type PendingAction, type ToolRegistry, type WorkspaceStore } from "../types.js";

export async function notifyOwnerOfPending(
  action: PendingAction,
  registry: ToolRegistry,
  workspaceStore: WorkspaceStore,
): Promise<void> {
  const workspace = workspaceStore.get(action.workspaceId);
  if (!workspace) return;

  const executor = registry.executors.get(LINE_PUSH_FLEX_TOOL);
  if (!executor) {
    // Flex Message 불가 시 텍스트 메시지로 폴백
    const textExecutor = registry.executors.get(LINE_PUSH_TEXT_TOOL);
    if (!textExecutor) return;

    await textExecutor({
      user_id: workspace.ownerId,
      messages: [{ type: "text", text: buildApprovalText(action, workspace.name) }],
    });
    return;
  }

  await executor({
    user_id: workspace.ownerId,
    messages: [buildApprovalFlexMessage(action, workspace.name)],
  });
}

export async function notifyActionResult(
  action: PendingAction,
  registry: ToolRegistry,
  targetUserId: string,
  executionError?: string,
): Promise<void> {
  const executor = registry.executors.get(LINE_PUSH_TEXT_TOOL);
  if (!executor) return;

  const statusText = action.status === "approved" ? "Approved" : "Rejected";
  const reason = action.rejectionReason ? `\nReason: ${action.rejectionReason}` : "";
  const errorNote = executionError ? `\n⚠ Execution error: ${executionError}` : "";

  await executor({
    user_id: targetUserId,
    messages: [{ type: "text", text: `[${statusText}] ${action.toolName}\n${action.requestContext}${reason}${errorNote}` }],
  });
}

function buildApprovalText(action: PendingAction, workspaceName: string): string {
  const inputSummary = Object.entries(action.toolInput)
    .map(([k, v]) => `  ${k}: ${String(v).slice(0, 100)}`)
    .join("\n");

  return `[Approval Request] ${workspaceName}\n` +
    `Requester: ${action.requesterId}\n` +
    `Operation: ${action.toolName}\n` +
    `Details:\n${inputSummary}\n` +
    `Original request: ${action.requestContext}\n\n` +
    `To approve, send "approve ${action.id}". To reject, send "reject ${action.id}".`;
}

function buildApprovalFlexMessage(
  action: PendingAction,
  workspaceName: string,
): Record<string, unknown> {
  const inputSummary = Object.entries(action.toolInput)
    .map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`)
    .join("\n");

  return {
    type: "flex",
    altText: `[Approval Request] ${action.toolName}`,
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: `Approval Request — ${workspaceName}`,
            weight: "bold",
            size: "md",
          },
        ],
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "text",
            text: `Operation: ${action.toolName}`,
            size: "sm",
          },
          {
            type: "text",
            text: inputSummary,
            size: "xs",
            wrap: true,
          },
          {
            type: "text",
            text: `Request: ${action.requestContext.slice(0, 200)}`,
            size: "xs",
            wrap: true,
            color: "#666666",
          },
        ],
      },
      footer: {
        type: "box",
        layout: "horizontal",
        spacing: "md",
        contents: [
          {
            type: "button",
            style: "primary",
            action: {
              type: "postback",
              label: "Approve",
              data: `action=approve&id=${action.id}`,
            },
          },
          {
            type: "button",
            style: "secondary",
            action: {
              type: "postback",
              label: "Reject",
              data: `action=reject&id=${action.id}`,
            },
          },
        ],
      },
    },
  };
}

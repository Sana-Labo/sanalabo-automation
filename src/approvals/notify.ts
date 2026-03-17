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
    // Fallback to text message
    const textExecutor = registry.executors.get(LINE_PUSH_TEXT_TOOL);
    if (!textExecutor) return;

    await textExecutor({
      user_id: workspace.ownerId,
      text: buildApprovalText(action, workspace.name),
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

  const statusText = action.status === "approved" ? "承認" : "却下";
  const reason = action.rejectionReason ? `\n理由: ${action.rejectionReason}` : "";
  const errorNote = executionError ? `\n⚠ 実行エラー: ${executionError}` : "";

  await executor({
    user_id: targetUserId,
    text: `[${statusText}] ${action.toolName}\n${action.requestContext}${reason}${errorNote}`,
  });
}

function buildApprovalText(action: PendingAction, workspaceName: string): string {
  const inputSummary = Object.entries(action.toolInput)
    .map(([k, v]) => `  ${k}: ${String(v).slice(0, 100)}`)
    .join("\n");

  return `[承認リクエスト] ${workspaceName}\n` +
    `リクエスト元: ${action.requesterId}\n` +
    `操作: ${action.toolName}\n` +
    `内容:\n${inputSummary}\n` +
    `元のリクエスト: ${action.requestContext}\n\n` +
    `承認するにはメッセージで「approve ${action.id}」、却下するには「reject ${action.id}」と送信してください。`;
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
    altText: `[承認リクエスト] ${action.toolName}`,
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: `承認リクエスト — ${workspaceName}`,
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
            text: `操作: ${action.toolName}`,
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
            text: `リクエスト: ${action.requestContext.slice(0, 200)}`,
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
              label: "承認",
              data: `action=approve&id=${action.id}`,
            },
          },
          {
            type: "button",
            style: "secondary",
            action: {
              type: "postback",
              label: "却下",
              data: `action=reject&id=${action.id}`,
            },
          },
        ],
      },
    },
  };
}

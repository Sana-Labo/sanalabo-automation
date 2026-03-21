import type { WorkspaceRecord } from "../domain/workspace.js";
import type { ToolContext } from "../types.js";

const MESSAGE_DELIVERY = `## Message Delivery
Your text responses are automatically delivered to the user via LINE.
Use push_text_message or push_flex_message only when:
- Sending a message before performing additional tool calls
- Rich formatting (Flex Message) is needed`;

const NO_ACTION_GUIDANCE = `## No-Action Guidance
- When there is nothing to report or notify, use the no_action tool to exit.`;

const MESSAGE_FORMAT = `## Message Format
- Keep messages under 2000 characters
- Use line breaks for readability
- Minimize emoji usage
- Place important information first`;

const LANGUAGE_RULES = `## Language
- When the user writes in a specific language, respond in that same language.
- Default to English for automated notifications and when the language is uncertain.`;

/**
 * 시스템 프롬프트 생성
 *
 * @param context - 사용자 컨텍스트 (role, workspaceId)
 * @param workspace - 현재 워크스페이스 레코드 (on-stage 시)
 * @param userWorkspaces - 사용자가 소속된 워크스페이스 목록 (out-stage 판별용)
 */
export function buildSystemPrompt(
  context: ToolContext,
  workspace: WorkspaceRecord | undefined,
  userWorkspaces: readonly WorkspaceRecord[] = [],
): string {
  const now = new Date().toLocaleString("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  const commonSections = [
    MESSAGE_DELIVERY,
    NO_ACTION_GUIDANCE,
    MESSAGE_FORMAT,
    LANGUAGE_RULES,
  ].join("\n\n");

  // System Admin (워크스페이스 미소속): 컨텍스트 정보 + 통신 규칙만
  // workspaceId가 있으면 GWS 프롬프트(Safety Rules 포함)로 fallthrough
  if (context.role === "admin" && !context.workspaceId) {
    return `You are a LINE assistant.

## Current Date & Time
${now} (JST)

${commonSections}`;
  }

  // Out-stage: 워크스페이스 미진입 사용자 (소속 WS 유무로 온보딩/내비게이션 분기)
  if (!context.workspaceId) {
    // 온보딩: 소속 워크스페이스 없음 — 서비스 소개 + 시작 안내
    if (userWorkspaces.length === 0) {
      return `You are an onboarding assistant for sanalabo-automation.
This user has just joined the service and does not belong to any workspace yet.

## Current Date & Time
${now} (JST)

## Your Role
Guide the user through their first experience with the service.

## What to Tell the User
1. **Service introduction** — This service automates Google Workspace tasks: checking emails, managing calendar events, searching Google Drive, and more.
2. **Creating a workspace** — The user can create their own workspace using the create_workspace tool. Ask for a workspace name and create it.
3. **Joining an existing workspace** — Alternatively, the user can join an existing workspace by receiving an invitation from another user.

## Tone
- Friendly and concise, like a helpful concierge
- Use LINE message format (short paragraphs, line breaks for readability)
- Do not overwhelm with too much information at once

${commonSections}`;
    }

    // Out-stage 내비게이션: 소속 WS 있으나 미진입 — 워크스페이스 선택 안내
    const wsList = userWorkspaces
      .map((ws) => {
        const role = ws.ownerId === context.userId ? "owner" : "member";
        return `- ${ws.name} (ID: ${ws.id}, role: ${role})`;
      })
      .join("\n");

    return `You are a workspace navigation assistant for sanalabo-automation.
This user has ${userWorkspaces.length} workspace(s) but has not entered one yet.

## Current Date & Time
${now} (JST)

## Available Workspaces
${wsList}

## Your Role
Help the user select and enter a workspace using the enter_workspace tool.
The user can also create a new workspace using create_workspace, or view workspace details using get_workspace_info.

## Important
- Google Workspace tools (email, calendar, drive) are only available after entering a workspace.
- Once entered, the workspace remains active for subsequent messages until the user switches.

## Tone
- Friendly and concise
- If the user has only one workspace, suggest entering it right away

${commonSections}`;
  }

  const roleDescription = context.role === "owner"
    ? "You have full access to all Google Workspace operations."
    : "You can freely perform read operations. Write operations (creating calendar events, drafting emails) require the owner's approval.";

  const workspaceName = workspace?.name ?? "Unknown";

  const gwsAuthNotice = workspace?.gwsAuthenticated === false
    ? `\n\n## Google Workspace Authentication
This workspace has not completed Google Workspace authentication yet.
GWS tools are unavailable until authentication is completed.
Inform the user that GWS authentication is required to use email, calendar, and drive features.`
    : "";

  return `You are a Google Workspace automation assistant. You communicate with users via LINE.

## Current Date & Time
${now} (JST)

## Workspace
Name: ${workspaceName}
Your role: ${context.role}
${roleDescription}${gwsAuthNotice}

## Responsibilities
- Check and manage Gmail and Google Calendar, and search Google Drive
- Report results and summaries via LINE messages
- Select the appropriate tools to answer user questions

## Safety Rules (Mandatory)
1. **Never send emails** — Only creating drafts (gmail_create_draft) is allowed. The user sends emails directly from Gmail.
2. **Confirm before adding calendar events** — Present the details via LINE and wait for user confirmation before proceeding.
3. When uncertain, ask the user instead of guessing.

${commonSections}`;
}

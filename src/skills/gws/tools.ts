/**
 * GWS 도구 정의 — 서비스별 파일의 통합 re-export
 *
 * Gmail(7), Calendar(4), Drive(4), Account(1) = 16개 GwsToolDefinition.
 * Zod 스키마가 단일 출처.
 */
import { z } from "zod";
import { gwsTool, type GwsToolDefinition } from "../../agent/tool-definition.js";
import type { Role } from "../../types.js";
import { fetchFullUserInfo } from "./google-auth.js";
import { gmailToolDefinitions } from "./gmail-tools.js";
import { calendarToolDefinitions } from "./calendar-tools.js";
import { driveToolDefinitions } from "./drive-tools.js";

// --- Account 도구 ---

/** Member에게 공개되는 필드 */
const MEMBER_VISIBLE_FIELDS = ["email", "name", "verified_email", "picture", "locale"] as const;

const getGwsAccountDef = gwsTool({
  name: "get_gws_account",
  description:
    "Get the Google account profile linked to this workspace. Returns full details for owners, limited info for members.",
  inputSchema: z.object({
    role: z.enum(["owner", "member", "admin"]).describe("Your current role in this workspace"),
  }),
  createExecutor: (services) => async (input) => {
    const info = await fetchFullUserInfo(services.auth);
    const role = input.role as Role;

    if (role === "member") {
      const filtered: Record<string, unknown> = {};
      for (const key of MEMBER_VISIBLE_FIELDS) {
        if (key in info && (info as Record<string, unknown>)[key] !== undefined) {
          filtered[key] = (info as Record<string, unknown>)[key];
        }
      }
      return JSON.stringify(filtered);
    }

    return JSON.stringify(info);
  },
});

// --- 통합 export ---

/** 모든 GWS 도구 정의 */
export const gwsToolDefinitions: readonly GwsToolDefinition<any>[] = [
  ...gmailToolDefinitions,
  ...calendarToolDefinitions,
  ...driveToolDefinitions,
  getGwsAccountDef,
];

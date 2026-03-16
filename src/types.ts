import type Anthropic from "@anthropic-ai/sdk";

// --- Tool System ---

export type ToolExecutor = (
  input: Record<string, unknown>,
) => Promise<string>;

export interface ToolRegistry {
  tools: Anthropic.Tool[];
  executors: Map<string, ToolExecutor>;
}

// --- Agent ---

export interface AgentResult {
  text: string;
  toolCalls: number;
}

// --- GWS ---

export type GwsCommandResult =
  | { success: true; data: unknown }
  | { success: false; data: null; error: string };

// --- LINE Webhook ---

export interface LineWebhookBody {
  destination: string;
  events: LineWebhookEvent[];
}

export interface LineSource {
  type: string;
  userId?: string;
}

interface LineEventBase {
  source: LineSource;
  timestamp: number;
}

export type LineWebhookEvent =
  | LineMessageEvent
  | LineFollowEvent
  | LineUnfollowEvent
  | LinePostbackEvent;

export interface LineMessageEvent extends LineEventBase {
  type: "message";
  message: LineTextMessage;
  replyToken: string;
}

export interface LineFollowEvent extends LineEventBase {
  type: "follow";
  replyToken: string;
}

export interface LineUnfollowEvent extends LineEventBase {
  type: "unfollow";
}

export interface LinePostbackEvent extends LineEventBase {
  type: "postback";
  postback: { data: string };
  replyToken: string;
}

interface LineTextMessage {
  type: "text";
  id: string;
  text: string;
}

// --- Users ---

export type UserStatus = "invited" | "active" | "inactive";

export interface UserRecord {
  status: UserStatus;
  invitedBy: string;
  invitedAt: string;
  activatedAt?: string;
  deactivatedAt?: string;
}

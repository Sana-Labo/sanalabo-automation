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

export type LineWebhookEvent =
  | LineMessageEvent
  | LineFollowEvent
  | LineUnfollowEvent
  | LinePostbackEvent
  | LineUnknownEvent;

export interface LineMessageEvent {
  type: "message";
  message: LineTextMessage;
  replyToken: string;
  source: { type: string; userId?: string };
  timestamp: number;
}

export interface LineFollowEvent {
  type: "follow";
  source: { type: string; userId?: string };
  replyToken: string;
  timestamp: number;
}

export interface LineUnfollowEvent {
  type: "unfollow";
  source: { type: string; userId?: string };
  timestamp: number;
}

export interface LinePostbackEvent {
  type: "postback";
  postback: { data: string };
  source: { type: string; userId?: string };
  replyToken: string;
  timestamp: number;
}

interface LineTextMessage {
  type: "text";
  id: string;
  text: string;
}

interface LineUnknownEvent {
  type: string;
  timestamp: number;
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

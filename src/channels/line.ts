import type {
  LineFollowEvent,
  LineMessageEvent,
  LinePostbackEvent,
  LineUnfollowEvent,
  LineWebhookBody,
  LineWebhookEvent,
} from "../types.js";

let cachedKey: CryptoKey | null = null;
let cachedSecret: string | null = null;

async function getHmacKey(channelSecret: string): Promise<CryptoKey> {
  if (cachedKey && cachedSecret === channelSecret) {
    return cachedKey;
  }
  cachedKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  cachedSecret = channelSecret;
  return cachedKey;
}

export async function verifyLineSignature(
  body: string,
  signature: string,
  channelSecret: string,
): Promise<boolean> {
  const key = await getHmacKey(channelSecret);

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }

  return crypto.subtle.verify("HMAC", key, signatureBytes, new TextEncoder().encode(body));
}

const KNOWN_EVENT_TYPES = new Set(["message", "follow", "unfollow", "postback"]);

export function parseLineEvents(body: string): LineWebhookEvent[] {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as LineWebhookBody).events)
    ) {
      return [];
    }
    return (parsed as LineWebhookBody).events.filter(
      (e: { type: string }) => KNOWN_EVENT_TYPES.has(e.type),
    ) as LineWebhookEvent[];
  } catch {
    return [];
  }
}

export function extractTextMessage(event: LineMessageEvent): string {
  return event.message.text;
}

export function isFollowEvent(e: LineWebhookEvent): e is LineFollowEvent {
  return e.type === "follow";
}

export function isUnfollowEvent(e: LineWebhookEvent): e is LineUnfollowEvent {
  return e.type === "unfollow";
}

export function isPostbackEvent(e: LineWebhookEvent): e is LinePostbackEvent {
  return e.type === "postback";
}

export function isTextMessageEvent(e: LineWebhookEvent): e is LineMessageEvent {
  return (
    e.type === "message" &&
    (e as LineMessageEvent).message?.type === "text"
  );
}

export function extractPostbackData(e: LinePostbackEvent): string {
  return e.postback.data;
}

export function extractUserId(event: LineWebhookEvent): string | undefined {
  return event.source.userId;
}

import type { LineMessageEvent, LineWebhookBody, LineWebhookEvent } from "../types.js";

export async function verifyLineSignature(
  body: string,
  signature: string,
  channelSecret: string,
): Promise<boolean> {
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }

  return crypto.subtle.verify("HMAC", key, signatureBytes, encoder.encode(body));
}

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
    return (parsed as LineWebhookBody).events;
  } catch {
    return [];
  }
}

export function extractTextMessage(event: LineMessageEvent): string {
  return event.message.text;
}

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
  const parsed = JSON.parse(body) as LineWebhookBody;
  return parsed.events;
}

export function extractTextMessage(event: LineMessageEvent): string {
  return event.message.text;
}

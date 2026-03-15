import type { LineMessageEvent, LineWebhookBody, LineWebhookEvent } from "../types.js";

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

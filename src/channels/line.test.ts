import { describe, test, expect } from "bun:test";
import {
  parseLineEvents,
  extractTextMessage,
  isFollowEvent,
  isUnfollowEvent,
  isPostbackEvent,
  isTextMessageEvent,
  extractPostbackData,
  extractUserId,
  verifyLineSignature,
} from "./line.js";
import type {
  LineMessageEvent,
  LineFollowEvent,
  LineUnfollowEvent,
  LinePostbackEvent,
  LineWebhookEvent,
} from "../types.js";

// --- Fixtures ---

const baseSource = { type: "user", userId: "U1234567890abcdef" };
const baseTimestamp = 1700000000000;

const textMessageEvent: LineMessageEvent = {
  type: "message",
  source: baseSource,
  timestamp: baseTimestamp,
  message: { type: "text", id: "msg001", text: "Hello!" },
  replyToken: "reply-token-1",
};

const followEvent: LineFollowEvent = {
  type: "follow",
  source: baseSource,
  timestamp: baseTimestamp,
  replyToken: "reply-token-2",
};

const unfollowEvent: LineUnfollowEvent = {
  type: "unfollow",
  source: baseSource,
  timestamp: baseTimestamp,
};

const postbackEvent: LinePostbackEvent = {
  type: "postback",
  source: baseSource,
  timestamp: baseTimestamp,
  postback: { data: "action=approve&id=123" },
  replyToken: "reply-token-3",
};

// --- Tests ---

describe("parseLineEvents", () => {
  test("valid body with events returns event array", () => {
    const body = JSON.stringify({
      destination: "dest",
      events: [textMessageEvent, followEvent],
    });
    const events = parseLineEvents(body);
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("message");
    expect(events[1]!.type).toBe("follow");
  });

  test("empty events array returns empty array", () => {
    const body = JSON.stringify({ destination: "dest", events: [] });
    expect(parseLineEvents(body)).toEqual([]);
  });

  test("invalid JSON returns empty array", () => {
    expect(parseLineEvents("not json")).toEqual([]);
  });

  test("missing events field returns empty array", () => {
    expect(parseLineEvents(JSON.stringify({ destination: "dest" }))).toEqual([]);
  });

  test("events not an array returns empty array", () => {
    expect(parseLineEvents(JSON.stringify({ events: "not-array" }))).toEqual([]);
  });

  test("unknown event types are filtered out", () => {
    const body = JSON.stringify({
      destination: "dest",
      events: [
        textMessageEvent,
        { type: "beacon", source: baseSource, timestamp: baseTimestamp },
        followEvent,
      ],
    });
    const events = parseLineEvents(body);
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("message");
    expect(events[1]!.type).toBe("follow");
  });
});

describe("type guards", () => {
  test("isFollowEvent", () => {
    expect(isFollowEvent(followEvent)).toBe(true);
    expect(isFollowEvent(textMessageEvent)).toBe(false);
    expect(isFollowEvent(unfollowEvent)).toBe(false);
    expect(isFollowEvent(postbackEvent)).toBe(false);
  });

  test("isUnfollowEvent", () => {
    expect(isUnfollowEvent(unfollowEvent)).toBe(true);
    expect(isUnfollowEvent(followEvent)).toBe(false);
    expect(isUnfollowEvent(textMessageEvent)).toBe(false);
  });

  test("isPostbackEvent", () => {
    expect(isPostbackEvent(postbackEvent)).toBe(true);
    expect(isPostbackEvent(textMessageEvent)).toBe(false);
    expect(isPostbackEvent(followEvent)).toBe(false);
  });

  test("isTextMessageEvent", () => {
    expect(isTextMessageEvent(textMessageEvent)).toBe(true);
    expect(isTextMessageEvent(followEvent)).toBe(false);
    expect(isTextMessageEvent(postbackEvent)).toBe(false);
  });
});

describe("extractTextMessage", () => {
  test("extracts message.text from text message event", () => {
    expect(extractTextMessage(textMessageEvent)).toBe("Hello!");
  });

  test("handles empty text", () => {
    const event: LineMessageEvent = {
      ...textMessageEvent,
      message: { type: "text", id: "msg002", text: "" },
    };
    expect(extractTextMessage(event)).toBe("");
  });
});

describe("extractPostbackData", () => {
  test("extracts postback.data", () => {
    expect(extractPostbackData(postbackEvent)).toBe("action=approve&id=123");
  });
});

describe("extractUserId", () => {
  test("extracts source.userId when present", () => {
    expect(extractUserId(textMessageEvent)).toBe("U1234567890abcdef");
  });

  test("returns undefined when userId is missing", () => {
    const event: LineWebhookEvent = {
      ...followEvent,
      source: { type: "room" },
    };
    expect(extractUserId(event)).toBeUndefined();
  });
});

describe("verifyLineSignature", () => {
  const secret = "test-channel-secret";

  async function signBody(body: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(body),
    );
    return btoa(String.fromCharCode(...new Uint8Array(sig)));
  }

  test("valid signature returns true", async () => {
    const body = '{"events":[]}';
    const signature = await signBody(body);
    expect(await verifyLineSignature(body, signature, secret)).toBe(true);
  });

  test("wrong signature returns false", async () => {
    const body = '{"events":[]}';
    const signature = await signBody(body);
    // Modify body after signing
    expect(await verifyLineSignature(body + "x", signature, secret)).toBe(false);
  });

  test("wrong secret returns false", async () => {
    const body = '{"events":[]}';
    const signature = await signBody(body);
    expect(await verifyLineSignature(body, signature, "wrong-secret")).toBe(false);
  });

  test("invalid base64 signature returns false", async () => {
    const body = '{"events":[]}';
    expect(await verifyLineSignature(body, "!!!not-base64!!!", secret)).toBe(false);
  });

  test("empty body with valid signature returns true", async () => {
    const body = "";
    const signature = await signBody(body);
    expect(await verifyLineSignature(body, signature, secret)).toBe(true);
  });
});

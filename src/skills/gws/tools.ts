import type Anthropic from "@anthropic-ai/sdk";

export const gwsTools: Anthropic.Tool[] = [
  {
    name: "gmail_list",
    strict: true,
    description:
      "List or search emails in Gmail. Supports full Gmail search syntax (e.g. 'is:unread', 'from:user@example.com', 'newer_than:1h is:important').",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Gmail search query. Omit to list recent emails.",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of results to return (default: 10)",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "gmail_get",
    strict: true,
    description: "Get a specific email message by ID with full content.",
    input_schema: {
      type: "object",
      properties: {
        messageId: {
          type: "string",
          description: "The Gmail message ID",
        },
      },
      required: ["messageId"],
      additionalProperties: false,
    },
  },
  {
    name: "gmail_create_draft",
    strict: true,
    description:
      "Create a draft email in Gmail. This does NOT send the email — it only saves a draft. After creating, inform the user that the draft has been saved and they must send it from Gmail.",
    input_schema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Recipient email address",
        },
        subject: {
          type: "string",
          description: "Email subject",
        },
        body: {
          type: "string",
          description: "Email body text",
        },
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "calendar_list",
    strict: true,
    description:
      "List calendar events within a time range. Defaults to today if not specified.",
    input_schema: {
      type: "object",
      properties: {
        timeMin: {
          type: "string",
          description: "Start time in ISO 8601 format",
        },
        timeMax: {
          type: "string",
          description: "End time in ISO 8601 format",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "calendar_create",
    strict: true,
    description:
      "Create a new calendar event. Always confirm with user via LINE before executing.",
    input_schema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "Event title",
        },
        start: {
          type: "string",
          description: "Start time in ISO 8601 format",
        },
        end: {
          type: "string",
          description: "End time in ISO 8601 format",
        },
        description: {
          type: "string",
          description: "Event description",
        },
      },
      required: ["summary", "start", "end"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_search",
    strict: true,
    description: "Search files in Google Drive.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Drive search query",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

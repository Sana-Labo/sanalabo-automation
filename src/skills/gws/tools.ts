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
    name: "gmail_send",
    strict: true,
    description:
      "Send an email. This action is irreversible — always confirm with the user before sending.",
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
        cc: {
          type: "string",
          description: "CC recipients (comma-separated)",
        },
        bcc: {
          type: "string",
          description: "BCC recipients (comma-separated)",
        },
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "gmail_reply",
    strict: true,
    description:
      "Reply to an existing email thread. This action is irreversible — always confirm with the user before replying.",
    input_schema: {
      type: "object",
      properties: {
        messageId: {
          type: "string",
          description: "The Gmail message ID to reply to",
        },
        body: {
          type: "string",
          description: "Reply body text",
        },
      },
      required: ["messageId", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "gmail_modify_labels",
    strict: true,
    description:
      "Add or remove labels from an email. Use this for archiving (remove INBOX), marking as read (remove UNREAD), starring, etc.",
    input_schema: {
      type: "object",
      properties: {
        messageId: {
          type: "string",
          description: "The Gmail message ID",
        },
        addLabelIds: {
          type: "array",
          items: { type: "string" },
          description: "Label IDs to add (e.g. 'STARRED', 'IMPORTANT')",
        },
        removeLabelIds: {
          type: "array",
          items: { type: "string" },
          description:
            "Label IDs to remove (e.g. 'INBOX' for archive, 'UNREAD' for mark-as-read)",
        },
      },
      required: ["messageId"],
      additionalProperties: false,
    },
  },
  {
    name: "gmail_trash",
    strict: true,
    description: "Move an email to the trash.",
    input_schema: {
      type: "object",
      properties: {
        messageId: {
          type: "string",
          description: "The Gmail message ID to trash",
        },
      },
      required: ["messageId"],
      additionalProperties: false,
    },
  },
  {
    name: "calendar_update",
    strict: true,
    description:
      "Update an existing calendar event. Only specified fields will be changed.",
    input_schema: {
      type: "object",
      properties: {
        eventId: {
          type: "string",
          description: "The calendar event ID",
        },
        summary: {
          type: "string",
          description: "New event title",
        },
        start: {
          type: "string",
          description: "New start time in ISO 8601 format",
        },
        end: {
          type: "string",
          description: "New end time in ISO 8601 format",
        },
        description: {
          type: "string",
          description: "New event description",
        },
      },
      required: ["eventId"],
      additionalProperties: false,
    },
  },
  {
    name: "calendar_delete",
    strict: true,
    description:
      "Delete a calendar event. This action is irreversible — always confirm with the user before deleting.",
    input_schema: {
      type: "object",
      properties: {
        eventId: {
          type: "string",
          description: "The calendar event ID to delete",
        },
      },
      required: ["eventId"],
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
  {
    name: "drive_get_content",
    strict: true,
    description:
      "Get the content of a file from Google Drive. For Google Docs/Sheets/Slides, exports as text. For other files, returns metadata.",
    input_schema: {
      type: "object",
      properties: {
        fileId: {
          type: "string",
          description: "The Drive file ID",
        },
      },
      required: ["fileId"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_upload",
    strict: true,
    description:
      "Upload a text file to Google Drive. For creating Google Docs, set mimeType to 'application/vnd.google-apps.document'.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "File name",
        },
        content: {
          type: "string",
          description: "File content (text)",
        },
        mimeType: {
          type: "string",
          description:
            "Target MIME type. Use 'application/vnd.google-apps.document' to create a Google Doc.",
        },
        folderId: {
          type: "string",
          description: "Parent folder ID (optional, defaults to root)",
        },
      },
      required: ["name", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_share",
    strict: true,
    description: "Share a file or folder with a user or make it public.",
    input_schema: {
      type: "object",
      properties: {
        fileId: {
          type: "string",
          description: "The Drive file or folder ID",
        },
        email: {
          type: "string",
          description: "Email address to share with (omit for public link)",
        },
        role: {
          type: "string",
          description:
            "Permission role: 'reader', 'commenter', or 'writer' (default: 'reader')",
        },
      },
      required: ["fileId"],
      additionalProperties: false,
    },
  },
];

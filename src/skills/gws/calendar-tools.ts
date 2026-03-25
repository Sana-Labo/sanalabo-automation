/**
 * Calendar 도구 (4개) — GwsToolDefinition 자기 완결적 구조
 *
 * Zod 스키마가 단일 출처. createExecutor로 Calendar API 클라이언트 주입.
 */
import { z } from "zod";
import type { calendar_v3 } from "@googleapis/calendar";
import { gwsTool, type GwsToolDefinition } from "../../agent/tool-definition.js";
import { CalendarScope } from "../../domain/google-scopes.js";
import { jsonResult } from "./api-helpers.js";

// --- 스키마 ---

const calendarListSchema = z.object({
  timeMin: z.string().describe("Start time in ISO 8601 format").optional(),
  timeMax: z.string().describe("End time in ISO 8601 format").optional(),
});

const calendarCreateSchema = z.object({
  summary: z.string().describe("Event title"),
  start: z.string().describe("Start time in ISO 8601 format"),
  end: z.string().describe("End time in ISO 8601 format"),
  description: z.string().describe("Event description").optional(),
});

const calendarUpdateSchema = z.object({
  eventId: z.string().describe("The calendar event ID"),
  summary: z.string().describe("New event title").optional(),
  start: z.string().describe("New start time in ISO 8601 format").optional(),
  end: z.string().describe("New end time in ISO 8601 format").optional(),
  description: z.string().describe("New event description").optional(),
});

const calendarDeleteSchema = z.object({
  eventId: z.string().describe("The calendar event ID to delete"),
});

// --- 도구 정의 ---

export const calendarList = gwsTool({
  name: "calendar_list",
  requiredScopes: [CalendarScope.FULL],
  description: "List calendar events within a time range. Defaults to today if not specified.",
  inputSchema: calendarListSchema,
  createExecutor: (s) => async (input) => {
    const res = await s.calendar.events.list({
      calendarId: "primary",
      timeMin: input.timeMin,
      timeMax: input.timeMax,
      singleEvents: true,
      orderBy: "startTime",
    });

    const events = (res.data.items ?? []).map((e) => ({
      id: e.id,
      summary: e.summary,
      start: e.start?.dateTime ?? e.start?.date,
      end: e.end?.dateTime ?? e.end?.date,
      description: e.description,
      location: e.location,
      status: e.status,
    }));

    return jsonResult({ events });
  },
});

export const calendarCreate = gwsTool({
  name: "calendar_create",
  requiredScopes: [CalendarScope.FULL],
  description:
    "Create a new calendar event. Always confirm with user via LINE before executing.",
  concurrency: "write",
  inputSchema: calendarCreateSchema,
  createExecutor: (s) => async (input) => {
    const res = await s.calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary: input.summary,
        start: { dateTime: input.start },
        end: { dateTime: input.end },
        description: input.description,
      },
    });

    return jsonResult({
      id: res.data.id,
      summary: res.data.summary,
      start: res.data.start?.dateTime,
      end: res.data.end?.dateTime,
      htmlLink: res.data.htmlLink,
    });
  },
});

export const calendarUpdate = gwsTool({
  name: "calendar_update",
  requiredScopes: [CalendarScope.FULL],
  description: "Update an existing calendar event. Only specified fields will be changed.",
  concurrency: "write",
  inputSchema: calendarUpdateSchema,
  createExecutor: (s) => async (input) => {
    const requestBody: calendar_v3.Schema$Event = {};
    if (input.summary !== undefined) requestBody.summary = input.summary;
    if (input.start !== undefined) requestBody.start = { dateTime: input.start };
    if (input.end !== undefined) requestBody.end = { dateTime: input.end };
    if (input.description !== undefined) requestBody.description = input.description;

    const res = await s.calendar.events.patch({
      calendarId: "primary",
      eventId: input.eventId,
      requestBody,
    });

    return jsonResult({
      id: res.data.id,
      summary: res.data.summary,
      start: res.data.start?.dateTime,
      end: res.data.end?.dateTime,
    });
  },
});

export const calendarDelete = gwsTool({
  name: "calendar_delete",
  requiredScopes: [CalendarScope.FULL],
  description:
    "Delete a calendar event. This action is irreversible — always confirm with the user before deleting.",
  concurrency: "write",
  inputSchema: calendarDeleteSchema,
  createExecutor: (s) => async (input) => {
    await s.calendar.events.delete({
      calendarId: "primary",
      eventId: input.eventId,
    });

    return jsonResult({ deleted: true, eventId: input.eventId });
  },
});

/** Calendar 도구 정의 배열 */
export const calendarToolDefinitions: readonly GwsToolDefinition<any>[] = [
  calendarList, calendarCreate, calendarUpdate, calendarDelete,
];

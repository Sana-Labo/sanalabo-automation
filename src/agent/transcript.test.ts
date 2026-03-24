import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TranscriptRecorder } from "./transcript.js";
import type { TranscriptRecord, TranscriptTurn } from "./transcript.js";

// --- 헬퍼 ---

/** 임시 데이터 디렉토리 */
let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "transcript-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** JSONL 파일을 파싱하여 TranscriptRecord 배열로 반환 */
async function readJsonl(filePath: string): Promise<TranscriptRecord[]> {
  const content = await readFile(filePath, "utf-8");
  return content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as TranscriptRecord);
}

// --- TranscriptRecorder ---

describe("TranscriptRecorder", () => {
  test("기본 라이프사이클: startRun → recordTurn → endRun → JSONL 기록", async () => {
    const recorder = new TranscriptRecorder(tempDir);

    recorder.startRun({
      userId: "U001",
      workspaceId: "ws-1",
      trigger: "webhook",
      userMessage: "오늘 일정 알려줘",
      systemPrompt: "You are an assistant.",
    });

    recorder.recordTurn({
      request: { model: "claude-haiku-4-5-20251001", messageCount: 1, toolCount: 5 },
      response: {
        stopReason: "tool_use",
        content: [
          { type: "text", text: "일정을 조회하겠습니다." },
          { type: "tool_use", id: "tu_1", name: "calendar_list", input: {} },
        ],
      },
      toolResults: [
        { toolUseId: "tu_1", toolName: "calendar_list", content: "[]", isError: false },
      ],
    });

    recorder.recordTurn({
      request: { model: "claude-haiku-4-5-20251001", messageCount: 3, toolCount: 5 },
      response: {
        stopReason: "end_turn",
        content: [{ type: "text", text: '{"text":"오늘 일정이 없습니다."}' }],
      },
      toolResults: [],
    });

    await recorder.endRun({
      result: { text: "오늘 일정이 없습니다.", toolCalls: 1, channelDelivered: false },
      usage: { totalInputTokens: 500, totalOutputTokens: 100 },
    });

    // JSONL 파일 확인
    const today = new Date().toISOString().slice(0, 10);
    const filePath = join(tempDir, "workspaces", "ws-1", "transcripts", `${today}.jsonl`);
    const records = await readJsonl(filePath);

    expect(records).toHaveLength(1);
    const record = records[0]!;

    // 메타데이터
    expect(record.id).toBeString();
    expect(record.userId).toBe("U001");
    expect(record.workspaceId).toBe("ws-1");
    expect(record.trigger).toBe("webhook");
    expect(record.userMessage).toBe("오늘 일정 알려줘");
    expect(record.systemPrompt).toBe("You are an assistant.");
    expect(record.startedAt).toBeString();
    expect(record.endedAt).toBeString();

    // 턴
    expect(record.turns).toHaveLength(2);
    expect(record.turns[0]!.turn).toBe(1);
    expect(record.turns[0]!.request.model).toBe("claude-haiku-4-5-20251001");
    expect(record.turns[0]!.response.stopReason).toBe("tool_use");
    expect(record.turns[0]!.toolResults).toHaveLength(1);
    expect(record.turns[1]!.turn).toBe(2);
    expect(record.turns[1]!.response.stopReason).toBe("end_turn");

    // 결과
    expect(record.result.text).toBe("오늘 일정이 없습니다.");
    expect(record.result.toolCalls).toBe(1);
    expect(record.result.channelDelivered).toBe(false);
    expect(record.usage.totalInputTokens).toBe(500);
    expect(record.usage.totalOutputTokens).toBe(100);
  });

  test("워크스페이스 미진입 시 no-workspace 경로에 기록", async () => {
    const recorder = new TranscriptRecorder(tempDir);

    recorder.startRun({
      userId: "U002",
      trigger: "webhook",
      userMessage: "hello",
      systemPrompt: "prompt",
    });

    await recorder.endRun({
      result: { text: "hi", toolCalls: 0, channelDelivered: false },
      usage: { totalInputTokens: 100, totalOutputTokens: 50 },
    });

    const today = new Date().toISOString().slice(0, 10);
    const filePath = join(tempDir, "transcripts", "no-workspace", `${today}.jsonl`);
    const records = await readJsonl(filePath);

    expect(records).toHaveLength(1);
    expect(records[0]!.workspaceId).toBeUndefined();
  });

  test("동일 파일에 여러 레코드 append", async () => {
    const recorder = new TranscriptRecorder(tempDir);

    // 1회차
    recorder.startRun({
      userId: "U001",
      workspaceId: "ws-1",
      trigger: "webhook",
      userMessage: "first",
      systemPrompt: "prompt",
    });
    await recorder.endRun({
      result: { text: "r1", toolCalls: 0, channelDelivered: false },
      usage: { totalInputTokens: 10, totalOutputTokens: 5 },
    });

    // 2회차
    recorder.startRun({
      userId: "U001",
      workspaceId: "ws-1",
      trigger: "cron",
      userMessage: "second",
      systemPrompt: "prompt",
    });
    await recorder.endRun({
      result: { text: "r2", toolCalls: 0, channelDelivered: false },
      usage: { totalInputTokens: 20, totalOutputTokens: 10 },
    });

    const today = new Date().toISOString().slice(0, 10);
    const filePath = join(tempDir, "workspaces", "ws-1", "transcripts", `${today}.jsonl`);
    const records = await readJsonl(filePath);

    expect(records).toHaveLength(2);
    expect(records[0]!.id).not.toBe(records[1]!.id);
    expect(records[0]!.trigger).toBe("webhook");
    expect(records[1]!.trigger).toBe("cron");
  });

  test("endRun 없이 startRun만 호출해도 에러 없음", () => {
    const recorder = new TranscriptRecorder(tempDir);

    // startRun만 호출 — 서버 크래시 시뮬레이션
    expect(() => {
      recorder.startRun({
        userId: "U005",
        trigger: "webhook",
        userMessage: "crash",
        systemPrompt: "prompt",
      });
    }).not.toThrow();
  });

  test("startedAt < endedAt 시간 순서 보장", async () => {
    const recorder = new TranscriptRecorder(tempDir);

    recorder.startRun({
      userId: "U001",
      workspaceId: "ws-1",
      trigger: "webhook",
      userMessage: "test",
      systemPrompt: "prompt",
    });

    // 약간의 시간 경과
    await new Promise((resolve) => setTimeout(resolve, 10));

    await recorder.endRun({
      result: { text: "done", toolCalls: 0, channelDelivered: false },
      usage: { totalInputTokens: 10, totalOutputTokens: 5 },
    });

    const today = new Date().toISOString().slice(0, 10);
    const filePath = join(tempDir, "workspaces", "ws-1", "transcripts", `${today}.jsonl`);
    const records = await readJsonl(filePath);

    expect(new Date(records[0]!.startedAt).getTime())
      .toBeLessThan(new Date(records[0]!.endedAt).getTime());
  });

  test("content 배열이 그대로 보존됨", async () => {
    const recorder = new TranscriptRecorder(tempDir);

    const content = [
      { type: "text" as const, text: "Let me check." },
      { type: "tool_use" as const, id: "tu_1", name: "gmail_list", input: { query: "is:unread" } },
    ];

    recorder.startRun({
      userId: "U001",
      workspaceId: "ws-1",
      trigger: "webhook",
      userMessage: "check mail",
      systemPrompt: "prompt",
    });

    recorder.recordTurn({
      request: { model: "claude-haiku-4-5-20251001", messageCount: 1, toolCount: 10 },
      response: { stopReason: "tool_use", content },
      toolResults: [
        { toolUseId: "tu_1", toolName: "gmail_list", content: '{"messages":[]}', isError: false },
      ],
    });

    await recorder.endRun({
      result: { text: "No unread mail.", toolCalls: 1, channelDelivered: false },
      usage: { totalInputTokens: 300, totalOutputTokens: 80 },
    });

    const today = new Date().toISOString().slice(0, 10);
    const filePath = join(tempDir, "workspaces", "ws-1", "transcripts", `${today}.jsonl`);
    const records = await readJsonl(filePath);

    const turn = records[0]!.turns[0]!;
    expect(turn.response.content).toEqual(content);
    expect(turn.toolResults[0]!.toolName).toBe("gmail_list");
  });
});

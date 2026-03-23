/**
 * 에이전트 트랜스크립트 기록
 *
 * 에이전트 루프의 전체 대화(system prompt + 턴별 request/response + 메타데이터)를
 * JSONL 파일에 기록하여, 에이전트의 자율 동작을 추적/디버깅 가능하게 한다.
 *
 * 업계 참조:
 * - 턴 기반 모델: Vercel AI SDK Step 배열 패턴
 * - JSONL append-only: Claude Agent SDK 세션 파일 패턴
 * - 비동기 기록: Vercel onStepFinish / Claude Agent SDK PostToolUse 패턴
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createLogger } from "../utils/logger.js";

const log = createLogger("transcript");

// --- 데이터 모델 ---

/** 에이전트 루프 1회의 전체 기록 */
export interface TranscriptRecord {
  /** 고유 ID */
  id: string;
  userId: string;
  workspaceId?: string;
  trigger: "webhook" | "cron" | "postback";
  /** ISO 8601 */
  startedAt: string;
  /** ISO 8601 */
  endedAt: string;
  /** 원본 사용자 입력 */
  userMessage: string;
  /** 에이전트에 제공된 시스템 프롬프트 */
  systemPrompt: string;
  /** 각 턴의 상세 */
  turns: TranscriptTurn[];
  result: {
    text: string;
    toolCalls: number;
    channelDelivered: boolean;
  };
  usage: {
    totalInputTokens: number;
    totalOutputTokens: number;
  };
}

/** Claude API 1회 호출(턴)의 상세 */
export interface TranscriptTurn {
  /** 1-based 턴 번호 */
  turn: number;
  request: {
    model: string;
    messageCount: number;
    toolCount: number;
  };
  response: {
    stopReason: string;
    content: unknown[];
  };
  toolResults: {
    toolUseId: string;
    toolName: string;
    content: string;
    isError: boolean;
  }[];
}

// --- startRun 파라미터 ---

/** startRun에 전달하는 파라미터 */
export interface StartRunParams {
  userId: string;
  workspaceId?: string;
  trigger: "webhook" | "cron" | "postback";
  userMessage: string;
  systemPrompt: string;
}

/** recordTurn에 전달하는 파라미터 */
export interface RecordTurnParams {
  request: TranscriptTurn["request"];
  response: TranscriptTurn["response"];
  toolResults: TranscriptTurn["toolResults"];
}

/** endRun에 전달하는 파라미터 */
export interface EndRunParams {
  result: TranscriptRecord["result"];
  usage: TranscriptRecord["usage"];
}

// --- TranscriptRecorder ---

/**
 * 에이전트 루프 트랜스크립트 기록기
 *
 * 사용법:
 * 1. `startRun()` — 루프 시작 시 호출
 * 2. `recordTurn()` — 매 턴 Claude API 응답 후 호출
 * 3. `endRun()` — 루프 종료 시 호출 → JSONL 파일에 기록
 *
 * @param dataDir - 데이터 루트 디렉토리 (예: `data/`)
 */
export class TranscriptRecorder {
  private readonly dataDir: string;
  private id = "";
  private startedAt = "";
  private userId = "";
  private workspaceId?: string;
  private trigger: TranscriptRecord["trigger"] = "webhook";
  private userMessage = "";
  private systemPrompt = "";
  private turns: TranscriptTurn[] = [];

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /** 기록 시작 — 루프 진입 시 호출 */
  startRun(params: StartRunParams): void {
    this.id = randomUUID();
    this.startedAt = new Date().toISOString();
    this.userId = params.userId;
    this.workspaceId = params.workspaceId;
    this.trigger = params.trigger;
    this.userMessage = params.userMessage;
    this.systemPrompt = params.systemPrompt;
    this.turns = [];
  }

  /** 턴 기록 — 매 Claude API 응답 후 호출 */
  recordTurn(params: RecordTurnParams): void {
    this.turns.push({
      turn: this.turns.length + 1,
      request: params.request,
      response: params.response,
      toolResults: params.toolResults,
    });
  }

  /**
   * 기록 완료 + JSONL 파일 쓰기
   *
   * 비동기 — 호출자가 await하면 쓰기 완료를 보장하지만,
   * 에이전트 루프에서는 fire-and-forget으로 사용 가능.
   */
  async endRun(params: EndRunParams): Promise<void> {
    if (!this.id) {
      log.warning("endRun called without startRun — skipping transcript write");
      return;
    }

    const record: TranscriptRecord = {
      id: this.id,
      userId: this.userId,
      workspaceId: this.workspaceId,
      trigger: this.trigger,
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      userMessage: this.userMessage,
      systemPrompt: this.systemPrompt,
      turns: this.turns,
      result: params.result,
      usage: params.usage,
    };

    await this.appendRecord(record);
  }

  /** JSONL append — 디렉토리 자동 생성 */
  private async appendRecord(record: TranscriptRecord): Promise<void> {
    const dir = this.resolveDir(record.workspaceId);
    // 시작 일자 기준 — 자정을 넘기는 장시간 루프도 시작 이벤트와 동일 파일에 기록
    const date = record.startedAt.slice(0, 10);
    const filePath = join(dir, `${date}.jsonl`);

    try {
      await mkdir(dir, { recursive: true });
      await appendFile(filePath, JSON.stringify(record) + "\n", "utf-8");
    } catch (e) {
      // 기록 실패가 에이전트 루프를 중단시키지 않도록 로그만 남김
      log.error("Failed to write transcript", { filePath, error: String(e) });
    }
  }

  /**
   * 워크스페이스 유무에 따른 저장 경로 결정
   *
   * - 워크스페이스 있음: `{dataDir}/workspaces/{workspaceId}/transcripts/`
   * - 워크스페이스 없음: `{dataDir}/transcripts/no-workspace/`
   */
  private resolveDir(workspaceId?: string): string {
    if (workspaceId) {
      return join(this.dataDir, "workspaces", workspaceId, "transcripts");
    }
    return join(this.dataDir, "transcripts", "no-workspace");
  }
}

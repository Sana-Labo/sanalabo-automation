/**
 * 도구 정의 인터페이스 + 유틸리티
 *
 * 모든 도구(infra, system, skill)가 공유하는 자기 완결적 인터페이스.
 * Zod 스키마가 단일 출처(single source of truth):
 * - Claude API용 JSON Schema: {@link toAnthropicTool}로 변환 (Zod 4 내장 z.toJSONSchema)
 * - 런타임 검증: inputSchema.safeParse()
 * - TypeScript 타입 추론: z.infer<typeof inputSchema>
 */
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type { gmail_v1 } from "@googleapis/gmail";
import type { calendar_v3 } from "@googleapis/calendar";
import type { drive_v3 } from "@googleapis/drive";
import type {
  AgentDependencies,
  ToolContext,
  ToolExecutor,
} from "../types.js";

/** 에이전트 내부 도구 핸들러의 공통 반환 시그널 */
export interface InternalToolSignal {
  /** Claude에 반환할 tool_result content */
  toolResult: string;
}

// --- 검증 결과 ---

/** Layer 2 비즈니스 검증 결과 */
export type ValidationResult =
  | { valid: true }
  | { valid: false; error: string };

// --- 공통 도구 정의 ---

/**
 * 모든 도구의 공통 기반 인터페이스
 *
 * 업계 표준 패턴: 도구 = 스키마 + 실행의 자기 완결적 단위.
 * Zod 스키마 하나로 API 전달(JSON Schema 변환) + 런타임 검증 + 타입 추론.
 */
/**
 * 도구 카테고리 — 디스패치 실행 패턴을 결정
 *
 * OpenAI Agents SDK의 Plan-then-Execute 패턴 참고:
 * 카테고리별 전용 executor로 분류 후 실행.
 *
 * - `infra`: 동기 실행, 루프 제어 (exitLoop 가능)
 * - `system`: 비동기, deps 접근 (Store I/O), 시그널 반환
 * - `skill`: 비동기 병렬, 외부 시스템 통신 (GWS, LINE)
 */
export type ToolCategory = "infra" | "system" | "skill";

export interface ToolDefinition<T = unknown> {
  /** 도구 이름 (Claude API tool name) */
  name: string;
  /** 도구 설명 (Claude에게 보여줌) */
  description: string;
  /** 디스패치 카테고리 — 실행 패턴 결정 */
  category: ToolCategory;
  /** 입력 스키마 — 단일 출처 */
  inputSchema: z.ZodType<T>;
  /**
   * strict tool 지정 (기본: false).
   * true면 Anthropic constrained decoding 적용 — 런타임 Zod 검증과 validateInput 모두 스킵.
   * constrained decoding이 JSON Schema 적합성을 보장하므로 이중 검증 불필요.
   */
  strict?: boolean;
  /**
   * Layer 2 비즈니스 검증 (Zod 파싱 성공 후 실행). 선택적 — Zod로 표현 불가한 검증용.
   * 주의: strict 도구에서는 실행되지 않음 (constrained decoding에 의존).
   */
  validateInput?: (input: T) => ValidationResult;
}

// --- 카테고리별 확장 ---

/** GWS API 서비스 클라이언트 묶음 — 워크스페이스별 OAuth 토큰으로 생성 */
export interface GwsServices {
  gmail: gmail_v1.Gmail;
  calendar: calendar_v3.Calendar;
  drive: drive_v3.Drive;
}

/** GWS 스킬 도구 — 워크스페이스별 API 클라이언트 주입 */
export interface GwsToolDefinition<T> extends ToolDefinition<T> {
  category: "skill";
  /** API 서비스 주입 → 타입 안전 executor 반환 */
  createExecutor: (services: GwsServices) => (input: T) => Promise<string>;
}

/** LINE 스킬 도구 — MCP executor + userId 주입 */
export interface LineToolDefinition<T> extends ToolDefinition<T> {
  category: "skill";
  /** MCP 원본 executor + userId → 래핑된 executor 반환 */
  createExecutor: (deps: {
    origExecutor: ToolExecutor;
    userId: string;
  }) => (input: T) => Promise<string>;
}

/** System 도구 시그널 — 워크스페이스 진입 시 executor 재구성 트리거 */
export interface SystemToolSignal extends InternalToolSignal {
  /** enter_workspace 호출 시 진입한 워크스페이스 ID */
  enteredWorkspaceId?: string;
}

/** System 도구 — deps 접근, strict 고정 */
export interface SystemToolDefinition<T> extends ToolDefinition<T> {
  category: "system";
  strict: true;
  /** 비동기 핸들러 — Store I/O 수행 */
  handler: (
    input: T,
    context: ToolContext,
    deps: AgentDependencies,
  ) => Promise<SystemToolSignal>;
}

/** 인프라 도구 시그널 — 루프 제어 필드 확장 */
export interface InfraToolSignal extends InternalToolSignal {
  /** true면 루프 즉시 종료 */
  exitLoop?: boolean;
  /** exitLoop 시 AgentResult.text (exitLoop: true일 때 필수) */
  exitText: string;
}

/** Infra 도구 — 동기, 루프 제어 가능, strict 고정 */
export interface InfraToolDefinition<T> extends ToolDefinition<T> {
  category: "infra";
  strict: true;
  /** 동기 핸들러 — 루프 제어 (exitLoop 가능) */
  handler: (input: T, context: ToolContext) => InfraToolSignal;
}

// --- 변환 유틸리티 ---

/**
 * ToolDefinition → Anthropic.Tool 변환
 *
 * Zod 4 내장 z.toJSONSchema()로 JSON Schema 생성 후 Anthropic API 형식으로 래핑.
 *
 * @param def - 도구 정의
 * @returns Claude API에 전달할 도구 객체
 */
/** 변환 캐시 — ToolDefinition 객체가 GC되면 캐시도 자동 제거 */
const anthropicToolCache = new WeakMap<ToolDefinition<any>, Anthropic.Tool>();

/**
 * ToolDefinition → Anthropic.Tool 변환 (캐시 적용)
 *
 * Zod 4 내장 z.toJSONSchema()로 JSON Schema 생성 후 Anthropic API 형식으로 래핑.
 * 동일 ToolDefinition 객체에 대해 변환 결과를 WeakMap에 캐시하여 반복 변환 방지.
 * 단일 출처 원칙 유지: 캐시는 정의에서 파생된 값이므로 불일치 불가.
 *
 * @param def - 도구 정의
 * @returns Claude API에 전달할 도구 객체
 */
export function toAnthropicTool(def: ToolDefinition<any>): Anthropic.Tool {
  const cached = anthropicToolCache.get(def);
  if (cached) return cached;

  const fullSchema = z.toJSONSchema(def.inputSchema);

  // $schema 필드 제거 (Anthropic API에 불필요)
  const { $schema: _, ...schema } = fullSchema as Record<string, unknown>;

  const tool: Anthropic.Tool = {
    name: def.name,
    description: def.description,
    ...(def.strict ? { strict: true } : {}),
    input_schema: {
      type: "object",
      ...schema,
      // Anthropic API는 additionalProperties: false 필수.
      // Zod 스키마가 passthrough() 등으로 true를 생성해도 의도적으로 false 강제.
      additionalProperties: false,
    } as unknown as Anthropic.Tool.InputSchema,
  };

  anthropicToolCache.set(def, tool);
  return tool;
}

/**
 * Zod 에러 → Claude 친화적 에러 메시지
 *
 * Claude가 입력을 정정하여 재시도할 수 있도록 구체적이고 actionable한 메시지 생성.
 *
 * @param error - Zod 파싱 에러
 * @returns 에러 메시지 문자열
 */
export function formatZodError(error: z.core.$ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

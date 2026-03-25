/**
 * 도구 디스패치 — 3단계 분류 실행 + 턴 트랜스크립트 기록
 *
 * loop.ts(오케스트레이터)에서 추출한 디스패치 로직.
 * Infra(동기, 루프 제어) → System(비동기, Store I/O) → Skill(비동기 병렬, 외부 시스템)
 */
import type Anthropic from "@anthropic-ai/sdk";
import {
  type AgentDependencies,
  type ToolContext,
  type ToolExecutor,
} from "../types.js";
import {
  toAnthropicTool,
  isInfraDef,
  isSystemDef,
  type ToolDefinition,
} from "./tool-definition.js";
import { createLogger } from "../utils/logger.js";
import type { GwsServiceStatus } from "../domain/google-scopes.js";
import type { WorkspaceRecord } from "../domain/workspace.js";
import { gwsToolDefinitions } from "../skills/gws/tools.js";
import { buildSystemPrompt } from "./system.js";
import type { TranscriptRecorder } from "./transcript.js";
import {
  executeFilterChain,
  type FilterContext,
  type ToolFilter,
} from "./filter-chain.js";

const log = createLogger("agent");

// --- LoopState ---

/** 에이전트 루프의 뮤터블 디스패치 상태 */
export interface LoopState {
  /** 현재 실행 컨텍스트 (userId, workspaceId, role) */
  context: ToolContext;
  /** 현재 시스템 프롬프트 */
  systemPrompt: string;
  /** 현재 활성 executor 맵 (registry + GWS + LINE) */
  executors: Map<string, ToolExecutor>;
  /** 전체 ToolDefinition 맵 (O(1) lookup) */
  allDefMap: Map<string, ToolDefinition<any>>;
  /** Claude API에 전달할 도구 목록 */
  allTools: Anthropic.Tool[];
  /** 트랜스크립트 기록기 */
  transcript: TranscriptRecorder;
}

/** 에이전트 루프 옵션 */
export interface AgentLoopOptions {
  /** no_action 도구 허용 여부. cron 잡에서만 true (기본: false) */
  allowNoAction?: boolean;
  /** 트랜스크립트 기록용 트리거 유형 (기본: "webhook") */
  trigger?: "webhook" | "cron" | "postback";
}

// --- 도구 목록 빌드 ---

/**
 * executor/handler가 존재하는 도구만 Claude에게 전달할 목록 생성
 *
 * @param allDefMap - 전체 ToolDefinition 맵
 * @param executors - 현재 활성 executor 맵
 * @param options - 루프 옵션 (no_action 허용 여부)
 */
export function buildToolList(
  allDefMap: Map<string, ToolDefinition<any>>,
  executors: Map<string, ToolExecutor>,
  options: AgentLoopOptions,
): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [];
  for (const [name, def] of allDefMap) {
    if (name === "no_action" && !options.allowNoAction) continue;
    if (def.category !== "skill" || executors.has(name)) {
      tools.push(toAnthropicTool(def));
    }
  }
  return tools;
}

// --- Agent Context Setup ---

/** setupContext 반환 타입 — capabilities → tools → prompt 순서로 생성된 결과 */
export interface ContextSetupResult {
  systemPrompt: string;
  allTools: Anthropic.Tool[];
}

/** GWS 서비스 접두사 → 서비스명 매핑 */
const GWS_SERVICE_PREFIXES: readonly [string, string][] = [
  ["Gmail", "gmail_"],
  ["Calendar", "calendar_"],
  ["Drive", "drive_"],
];

/**
 * executor map에서 GWS 서비스 가용 상태 도출
 *
 * @param executors - 현재 활성 executor 맵
 * @returns 서비스 가용 상태. GWS executor가 없으면 undefined
 */
export function deriveGwsServiceStatus(
  executors: Map<string, ToolExecutor>,
): GwsServiceStatus | undefined {
  const hasAnyGws = GWS_SERVICE_PREFIXES.some(([, prefix]) =>
    [...executors.keys()].some((k) => k.startsWith(prefix)),
  );
  // GWS executor가 하나도 없으면 미인증 상태 — scope 상태 표시 불필요
  if (!hasAnyGws) return undefined;

  const available: string[] = [];
  const unavailable: string[] = [];
  for (const [name, prefix] of GWS_SERVICE_PREFIXES) {
    if ([...executors.keys()].some((k) => k.startsWith(prefix))) {
      available.push(name);
    } else {
      unavailable.push(name);
    }
  }
  return { available, unavailable };
}

/**
 * Agent Context Setup — capabilities → tools → prompt 순서로 컨텍스트 구성
 *
 * 초기 setup과 mid-loop rebuild(워크스페이스 진입/퇴장) 모두에서 사용.
 * 향후 매 턴 호출 가능한 순수+멱등 구조.
 *
 * @param context - 사용자 컨텍스트
 * @param executors - 현재 활성 executor 맵 (capabilities)
 * @param allDefMap - 전체 ToolDefinition 맵
 * @param options - 루프 옵션
 * @param workspace - 현재 워크스페이스 (on-stage 시)
 * @param userWorkspaces - 사용자 소속 워크스페이스 목록 (out-stage 시)
 */
export function setupContext(
  context: ToolContext,
  executors: Map<string, ToolExecutor>,
  allDefMap: Map<string, ToolDefinition<any>>,
  options: AgentLoopOptions,
  workspace?: WorkspaceRecord,
  userWorkspaces?: readonly WorkspaceRecord[],
): ContextSetupResult {
  // [1] Capabilities에서 서비스 상태 도출
  const gwsServiceStatus = workspace
    ? deriveGwsServiceStatus(executors)
    : undefined;

  // [2] Tool set 구성
  const allTools = buildToolList(allDefMap, executors, options);

  // [3] Prompt 조립 (capabilities 반영)
  const systemPrompt = buildSystemPrompt(
    context, workspace, userWorkspaces, gwsServiceStatus,
  );

  return { systemPrompt, allTools };
}

// --- GWS executor 병합 ---

/**
 * GWS executor를 대상 맵에 병합
 *
 * getGwsExecutors → null 체크 → Map merge 패턴의 단일 출처.
 * loop.ts에서 2곳(초기화, 워크스페이스 진입)에서 중복 사용되던 패턴을 통합.
 */
export async function mergeGwsExecutors(
  target: Map<string, ToolExecutor>,
  deps: AgentDependencies,
  workspaceId: string,
): Promise<void> {
  const gwsExecs = await deps.getGwsExecutors(workspaceId);
  if (gwsExecs) {
    for (const [name, exec] of gwsExecs) {
      target.set(name, exec);
    }
  }
}

// --- 디스패치 결과 타입 ---

/** exitLoop 시 루프를 종료하기 위한 결과 (toolCalls 제외 — 루프 레벨에서 누적) */
export interface ExitResult {
  text: string;
}

/** infra 디스패치 결과 */
export interface InfraDispatchResult {
  results: Anthropic.ToolResultBlockParam[];
  /** exitLoop 시그널이 발생한 경우 루프를 종료하기 위한 결과 */
  exitResult?: ExitResult;
  /** 처리된 도구 호출 수 */
  toolCallCount: number;
}

/** 턴 트랜스크립트 기록에 필요한 요청/응답 정보 */
export interface TurnInfo {
  model: string;
  messageCount: number;
  toolCount: number;
  stopReason: string;
  content: Anthropic.ContentBlock[];
}

// --- DispatchPlan (Categorized Batch) ---

/**
 * 도구 호출 분류 결과 — OpenAI Agents SDK Plan-then-Execute 패턴
 *
 * tool_use 블록을 카테고리별로 사전 분류하여, 각 카테고리에 적합한 실행 전략 적용.
 * handled Set 기반 암묵적 분류를 대체하는 명시적 분류 객체.
 */
export interface DispatchPlan {
  infra: Anthropic.ToolUseBlock[];
  system: Anthropic.ToolUseBlock[];
  skill: Anthropic.ToolUseBlock[];
}

/**
 * tool_use 블록을 카테고리별로 분류
 *
 * @param blocks - LLM 응답의 tool_use 블록들
 * @param defMap - 전체 ToolDefinition 맵
 * @returns 카테고리별 분류 결과. 미등록 도구는 skill로 분류 (executor 미발견 에러로 처리)
 */
export function classifyToolCalls(
  blocks: Anthropic.ToolUseBlock[],
  defMap: Map<string, ToolDefinition<any>>,
): DispatchPlan {
  const plan: DispatchPlan = { infra: [], system: [], skill: [] };
  for (const block of blocks) {
    const def = defMap.get(block.name);
    if (def && isInfraDef(def)) {
      plan.infra.push(block);
    } else if (def && isSystemDef(def)) {
      plan.system.push(block);
    } else {
      // skill 도구 + 미등록 도구 (미등록은 executorFilter에서 에러 처리)
      plan.skill.push(block);
    }
  }
  return plan;
}

// --- 3단계 디스패치 ---

/**
 * 3단계 디스패치 + 턴 트랜스크립트 기록
 *
 * DispatchPlan으로 사전 분류 → 카테고리별 실행 → 결과 통합 → recordTurn 1회.
 *
 * @param filters - skill 도구에 적용할 필터 체인
 * @returns 통합 tool_result 배열 + 루프 종료 결과(있는 경우) + 통계
 */
export async function dispatchAllTools(
  toolUseBlocks: Anthropic.ToolUseBlock[],
  state: LoopState,
  deps: AgentDependencies,
  options: AgentLoopOptions,
  turnInfo: TurnInfo,
  userMessage: string,
  filters: ToolFilter[],
): Promise<{
  results: Anthropic.ToolResultBlockParam[];
  exitResult?: ExitResult;
  toolCallCount: number;
  channelDelivered: boolean;
}> {
  // Plan: 카테고리별 분류
  const plan = classifyToolCalls(toolUseBlocks, state.allDefMap);

  // [1단계] Infra
  const infraResult = dispatchInfra(plan.infra, state);

  if (infraResult.exitResult) {
    // exitLoop 턴 기록
    state.transcript.recordTurn({
      request: { model: turnInfo.model, messageCount: turnInfo.messageCount, toolCount: turnInfo.toolCount },
      response: { stopReason: turnInfo.stopReason, content: turnInfo.content },
      toolResults: infraResult.results.map((r) => {
        const block = plan.infra.find((b) => b.id === r.tool_use_id);
        return {
          toolUseId: r.tool_use_id,
          toolName: block?.name ?? "",
          content: typeof r.content === "string" ? r.content : JSON.stringify(r.content ?? ""),
          isError: false,
        };
      }),
    });
    return {
      results: infraResult.results,
      exitResult: infraResult.exitResult,
      toolCallCount: infraResult.toolCallCount,
      channelDelivered: false,
    };
  }

  // [2단계] System
  const systemResult = await dispatchSystem(plan.system, state, deps, options);

  // [3단계] Skill — 필터 체인 + 읽기/쓰기 분리
  const skillResult = await dispatchSkill(plan.skill, state, filters, userMessage);

  const allResults = [...infraResult.results, ...systemResult.results, ...skillResult.results];
  const totalToolCalls = infraResult.toolCallCount + systemResult.toolCallCount + skillResult.toolCallCount;

  // 턴 트랜스크립트 기록 — O(n) Map lookup
  const resultById = new Map(allResults.map((r) => [r.tool_use_id, r]));
  state.transcript.recordTurn({
    request: { model: turnInfo.model, messageCount: turnInfo.messageCount, toolCount: turnInfo.toolCount },
    response: { stopReason: turnInfo.stopReason, content: turnInfo.content },
    toolResults: toolUseBlocks.map((block) => {
      const tr = resultById.get(block.id);
      return {
        toolUseId: block.id,
        toolName: block.name,
        content: typeof tr?.content === "string" ? tr.content : JSON.stringify(tr?.content ?? ""),
        isError: tr?.is_error === true,
      };
    }),
  });

  return {
    results: allResults,
    toolCallCount: totalToolCalls,
    channelDelivered: skillResult.channelDelivered,
  };
}

/**
 * [1단계] Infra 도구 디스패치 — 동기, 루프 제어
 *
 * exitLoop 시그널 발생 시 즉시 반환 (나머지 도구 실행 안 함).
 */
export function dispatchInfra(
  toolUseBlocks: Anthropic.ToolUseBlock[],
  state: LoopState,
): InfraDispatchResult {
  const results: Anthropic.ToolResultBlockParam[] = [];
  let toolCallCount = 0;

  for (const block of toolUseBlocks) {
    const def = state.allDefMap.get(block.name);
    if (!def || !isInfraDef(def)) continue;
    toolCallCount++;
    log.debug("Infra tool handled", () => ({ tool: block.name, toolUseId: block.id }));
    const signal = def.handler(block.input as any, state.context);
    if (signal.exitLoop) {
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: signal.toolResult,
      });
      return {
        results,
        exitResult: { text: signal.exitText },
        toolCallCount,
      };
    }
    results.push({
      type: "tool_result",
      tool_use_id: block.id,
      content: signal.toolResult,
    });
  }

  return { results, toolCallCount };
}

/**
 * [2단계] System 도구 디스패치 — 비동기, Store I/O, LoopState 변경
 *
 * enter_workspace / leave_workspace 시그널에 따라 LoopState를 직접 변경:
 * - enter: GWS executor 추가, context 갱신, system prompt 재생성
 * - leave: GWS executor 제거, context 클리어, system prompt 재생성
 */
export async function dispatchSystem(
  toolUseBlocks: Anthropic.ToolUseBlock[],
  state: LoopState,
  deps: AgentDependencies,
  options: AgentLoopOptions,
): Promise<{ results: Anthropic.ToolResultBlockParam[]; toolCallCount: number }> {
  const results: Anthropic.ToolResultBlockParam[] = [];
  let toolCallCount = 0;

  for (const block of toolUseBlocks) {
    const def = state.allDefMap.get(block.name);
    if (!def || !isSystemDef(def)) continue;
    toolCallCount++;
    log.debug("System tool handled", () => ({ tool: block.name, toolUseId: block.id }));
    const signal = await def.handler(block.input as any, state.context, deps);
    results.push({
      type: "tool_result",
      tool_use_id: block.id,
      content: signal.toolResult,
    });

    // enter_workspace 후 executor + context 재구성
    if (signal.enteredWorkspaceId) {
      const enteredWs = deps.workspaceStore.get(signal.enteredWorkspaceId);
      if (enteredWs) {
        await mergeGwsExecutors(state.executors, deps, enteredWs.id);
        state.context = {
          ...state.context,
          workspaceId: enteredWs.id,
          role: deps.workspaceStore.getUserRole(enteredWs.id, state.context.userId) ?? state.context.role,
        };
        const result = setupContext(state.context, state.executors, state.allDefMap, options, enteredWs);
        state.allTools = result.allTools;
        state.systemPrompt = result.systemPrompt;
        log.info("Context rebuilt after workspace entry", { workspaceId: enteredWs.id, toolCount: state.allTools.length });
      }
    }

    // leave_workspace 후 GWS executor 제거 + Out-stage 전환
    if (signal.leftWorkspace) {
      for (const gwsDef of gwsToolDefinitions) {
        state.executors.delete(gwsDef.name);
      }
      state.context = { userId: state.context.userId, role: state.context.role };
      const userWorkspaces = deps.workspaceStore.getByMember(state.context.userId);
      const result = setupContext(state.context, state.executors, state.allDefMap, options, undefined, userWorkspaces);
      state.allTools = result.allTools;
      state.systemPrompt = result.systemPrompt;
      log.info("Workspace left, context rebuilt", { userId: state.context.userId, toolCount: state.allTools.length });
    }
  }

  return { results, toolCallCount };
}

/**
 * [3단계] Skill 도구 디스패치 — 필터 체인 + 읽기/쓰기 동시성 분리
 *
 * 각 도구가 필터 체인을 통과: logging → writeIntercept → zodValidation → executor.
 * concurrency 기반 실행 전략:
 * - read 도구: Promise.all 병렬
 * - write 도구: 순차 실행
 * - dynamic 도구: isMutating(input) 결과에 따라 분류
 */
export async function dispatchSkill(
  toolUseBlocks: Anthropic.ToolUseBlock[],
  state: LoopState,
  filters: ToolFilter[],
  userMessage: string,
): Promise<{ results: Anthropic.ToolResultBlockParam[]; toolCallCount: number; channelDelivered: boolean }> {
  // JS 단일 스레드에서 Promise.all 내 동기 변수 변경은 안전 — await 간 인터리빙만 발생
  let channelDelivered = false;

  /** 단일 도구를 필터 체인으로 실행 */
  async function executeOne(block: Anthropic.ToolUseBlock): Promise<Anthropic.ToolResultBlockParam> {
    const ctx: FilterContext = {
      toolName: block.name,
      toolUseId: block.id,
      input: block.input as Record<string, unknown>,
      definition: state.allDefMap.get(block.name),
      context: state.context,
      userMessage,
      metadata: {},
    };

    await executeFilterChain(filters, ctx);

    if (ctx.channelDelivered) channelDelivered = true;

    return {
      type: "tool_result" as const,
      tool_use_id: block.id,
      content: ctx.result ?? "",
      ...(ctx.isError ? { is_error: true } : {}),
    };
  }

  // 읽기/쓰기 분류 (concurrency 기반)
  const readBlocks: Anthropic.ToolUseBlock[] = [];
  const writeBlocks: Anthropic.ToolUseBlock[] = [];

  for (const block of toolUseBlocks) {
    const def = state.allDefMap.get(block.name);
    const concurrency = def?.concurrency ?? "read";
    if (concurrency === "write") {
      writeBlocks.push(block);
    } else if (concurrency === "dynamic" && def?.isMutating?.(block.input as any)) {
      writeBlocks.push(block);
    } else {
      readBlocks.push(block);
    }
  }

  // Phase A: 읽기 도구 — 병렬 실행
  const readResults = await Promise.all(readBlocks.map(executeOne));

  // Phase B: 쓰기 도구 — 순차 실행
  const writeResults: Anthropic.ToolResultBlockParam[] = [];
  for (const block of writeBlocks) {
    writeResults.push(await executeOne(block));
  }

  return {
    results: [...readResults, ...writeResults],
    toolCallCount: toolUseBlocks.length,
    channelDelivered,
  };
}

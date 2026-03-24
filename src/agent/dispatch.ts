/**
 * 도구 디스패치 — 3단계 분류 실행 + 턴 트랜스크립트 기록
 *
 * loop.ts(오케스트레이터)에서 추출한 디스패치 로직.
 * Infra(동기, 루프 제어) → System(비동기, Store I/O) → Skill(비동기 병렬, 외부 시스템)
 */
import type Anthropic from "@anthropic-ai/sdk";
import { interceptWrite } from "../approvals/interceptor.js";
import { notifyOwnerOfPending } from "../approvals/notify.js";
import {
  CHANNEL_SKILL_TOOL_NAMES,
  type AgentDependencies,
  type AgentResult,
  type ToolContext,
  type ToolExecutor,
} from "../types.js";
import {
  toAnthropicTool,
  formatZodError,
  isInfraDef,
  isSystemDef,
  type ToolDefinition,
} from "./tool-definition.js";
import { toErrorMessage } from "../utils/error.js";
import { createLogger } from "../utils/logger.js";
import type { WorkspaceRecord } from "../domain/workspace.js";
import { gwsToolDefinitions } from "../skills/gws/tools.js";
import { buildSystemPrompt } from "./system.js";
import type { TranscriptRecorder } from "./transcript.js";

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

// --- 상태 재구성 헬퍼 ---

/** 도구 목록 재생성 (executor 변경 후 호출) */
export function rebuildTools(state: LoopState, options: AgentLoopOptions): void {
  state.allTools = buildToolList(state.allDefMap, state.executors, options);
}

/** 시스템 프롬프트 재생성 (컨텍스트 변경 후 호출) */
export function rebuildPrompt(
  state: LoopState,
  workspace?: WorkspaceRecord,
  userWorkspaces?: readonly WorkspaceRecord[],
): void {
  state.systemPrompt = buildSystemPrompt(state.context, workspace, userWorkspaces);
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
  channelDelivered: boolean;
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

// --- 3단계 디스패치 ---

/**
 * 3단계 디스패치 + 턴 트랜스크립트 기록
 *
 * infra → system → skill 순서로 실행 후 결과를 통합하여 recordTurn 1회 호출.
 *
 * @returns 통합 tool_result 배열 + 루프 종료 결과(있는 경우) + 통계
 */
export async function dispatchAllTools(
  toolUseBlocks: Anthropic.ToolUseBlock[],
  state: LoopState,
  deps: AgentDependencies,
  options: AgentLoopOptions,
  turnInfo: TurnInfo,
  userMessage: string,
): Promise<{
  results: Anthropic.ToolResultBlockParam[];
  exitResult?: ExitResult;
  toolCallCount: number;
  channelDelivered: boolean;
}> {
  // [1단계] Infra
  const infraResult = dispatchInfra(toolUseBlocks, state);

  if (infraResult.exitResult) {
    // exitLoop 턴 기록
    state.transcript.recordTurn({
      request: { model: turnInfo.model, messageCount: turnInfo.messageCount, toolCount: turnInfo.toolCount },
      response: { stopReason: turnInfo.stopReason, content: turnInfo.content },
      toolResults: infraResult.results.map((r) => ({
        toolUseId: r.tool_use_id,
        toolName: toolUseBlocks.find((b) => b.id === r.tool_use_id)?.name ?? "",
        content: typeof r.content === "string" ? r.content : JSON.stringify(r.content ?? ""),
        isError: false,
      })),
    });
    return {
      results: infraResult.results,
      exitResult: infraResult.exitResult,
      toolCallCount: infraResult.toolCallCount,
      channelDelivered: false,
    };
  }

  // infra에서 처리된 ID Set
  const handledIds = new Set(infraResult.results.map((r) => r.tool_use_id));

  // [2단계] System
  const systemResult = await dispatchSystem(
    toolUseBlocks.filter((b) => !handledIds.has(b.id)),
    state,
    deps,
    options,
  );
  for (const r of systemResult.results) handledIds.add(r.tool_use_id);

  // [3단계] Skill
  const skillResult = await dispatchSkill(
    toolUseBlocks.filter((b) => !handledIds.has(b.id)),
    state,
    deps,
    userMessage,
  );

  const allResults = [...infraResult.results, ...systemResult.results, ...skillResult.results];
  const totalToolCalls = infraResult.toolCallCount + systemResult.toolCallCount + skillResult.toolCallCount;

  // 턴 트랜스크립트 기록 — 3단계 결과 통합
  state.transcript.recordTurn({
    request: { model: turnInfo.model, messageCount: turnInfo.messageCount, toolCount: turnInfo.toolCount },
    response: { stopReason: turnInfo.stopReason, content: turnInfo.content },
    toolResults: toolUseBlocks.map((block) => {
      const tr = allResults.find((r) => r.tool_use_id === block.id);
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
    exitResult: undefined,
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
    const maybeDef = state.allDefMap.get(block.name);
    if (!maybeDef || !isInfraDef(maybeDef)) continue;
    const def = maybeDef;
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
        exitResult: { text: signal.exitText, channelDelivered: false },
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
    const maybeDef = state.allDefMap.get(block.name);
    if (!maybeDef || !isSystemDef(maybeDef)) continue;
    const def = maybeDef;
    toolCallCount++;
    log.debug("System tool handled", () => ({ tool: block.name, toolUseId: block.id }));
    const signal = await def.handler(block.input as any, state.context, deps);
    results.push({
      type: "tool_result",
      tool_use_id: block.id,
      content: signal.toolResult,
    });

    // enter_workspace 후 executor + tools 동적 재구성
    if (signal.enteredWorkspaceId) {
      const enteredWs = deps.workspaceStore.get(signal.enteredWorkspaceId);
      if (enteredWs) {
        await mergeGwsExecutors(state.executors, deps, enteredWs.id);
        rebuildTools(state, options);
        state.context = {
          ...state.context,
          workspaceId: enteredWs.id,
          role: deps.workspaceStore.getUserRole(enteredWs.id, state.context.userId) ?? state.context.role,
        };
        rebuildPrompt(state, enteredWs);
        log.info("Executor rebuilt after workspace entry", { workspaceId: enteredWs.id, toolCount: state.allTools.length });
      }
    }

    // leave_workspace 후 GWS executor 제거 + Out-stage 전환
    if (signal.leftWorkspace) {
      for (const def of gwsToolDefinitions) {
        state.executors.delete(def.name);
      }
      rebuildTools(state, options);
      state.context = { userId: state.context.userId, role: state.context.role };
      const userWorkspaces = deps.workspaceStore.getByMember(state.context.userId);
      rebuildPrompt(state, undefined, userWorkspaces);
      log.info("Workspace left, prompt rebuilt", { userId: state.context.userId, toolCount: state.allTools.length });
    }
  }

  return { results, toolCallCount };
}

/**
 * [3단계] Skill 도구 디스패치 — 비동기 병렬, 외부 시스템 통신
 *
 * interceptWrite → Zod 검증 → executor 실행.
 * 모든 skill 도구를 Promise.all로 병렬 실행 (PR #28에서 읽기/쓰기 분리 예정).
 */
export async function dispatchSkill(
  toolUseBlocks: Anthropic.ToolUseBlock[],
  state: LoopState,
  deps: AgentDependencies,
  userMessage: string,
): Promise<{ results: Anthropic.ToolResultBlockParam[]; toolCallCount: number; channelDelivered: boolean }> {
  // JS 단일 스레드에서 Promise.all 내 동기 변수 변경은 안전 — await 간 인터리빙만 발생
  let channelDelivered = false;
  let toolCallCount = 0;

  const results = await Promise.all(
    toolUseBlocks.map(async (block) => {
      toolCallCount++;
      log.debug("Tool call", () => ({ tool: block.name, toolUseId: block.id }));
      let toolInput = block.input as Record<string, unknown>;

      // 비오너 멤버의 write 도구 가로채기 — concurrency 기반 판별
      const def = state.allDefMap.get(block.name);
      const interception = await interceptWrite(
        block.name,
        def?.concurrency,
        toolInput,
        state.context,
        deps.pendingActionStore,
        userMessage,
      );

      if (interception.intercepted) {
        log.debug("Write intercepted", () => ({ tool: block.name, pendingActionId: interception.pendingAction.id }));
        notifyOwnerOfPending(
          interception.pendingAction,
          deps.registry,
          deps.workspaceStore,
        ).catch((e) => {
          log.error("Failed to notify owner of pending action", { pendingActionId: interception.pendingAction.id, error: toErrorMessage(e) });
        });

        return {
          type: "tool_result" as const,
          tool_use_id: block.id,
          content: "This operation requires the owner's approval. An approval request has been sent.",
        };
      }

      const executor = state.executors.get(block.name);

      if (!executor) {
        return {
          type: "tool_result" as const,
          tool_use_id: block.id,
          content: `Error: Unknown tool "${block.name}"`,
          is_error: true,
        };
      }

      // Zod 검증 파이프라인 (non-strict 도구만 — PR #28에서 전체 적용 예정)
      if (def && !def.strict) {
        const parsed = def.inputSchema.safeParse(toolInput);
        if (!parsed.success) {
          log.debug("Input validation failed", () => ({ tool: block.name, error: formatZodError(parsed.error) }));
          return {
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: `Input validation error (please fix and retry): ${formatZodError(parsed.error)}`,
            is_error: true,
          };
        }
        if (def.validateInput) {
          const validation = def.validateInput(parsed.data);
          if (!validation.valid) {
            log.debug("Business validation failed", () => ({ tool: block.name, error: validation.error }));
            return {
              type: "tool_result" as const,
              tool_use_id: block.id,
              content: validation.error,
              is_error: true,
            };
          }
        }
        toolInput = parsed.data;
      }

      try {
        const result = await executor(toolInput);
        log.debug("Tool succeeded", () => ({ tool: block.name, resultLength: result.length }));
        if (CHANNEL_SKILL_TOOL_NAMES.has(block.name)) {
          channelDelivered = true;
        }
        return {
          type: "tool_result" as const,
          tool_use_id: block.id,
          content: result,
        };
      } catch (e) {
        log.debug("Tool failed", () => ({ tool: block.name, error: toErrorMessage(e) }));
        return {
          type: "tool_result" as const,
          tool_use_id: block.id,
          content: `Error: ${toErrorMessage(e)}`,
          is_error: true,
        };
      }
    }),
  );

  return { results, toolCallCount, channelDelivered };
}

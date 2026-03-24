/**
 * 필터 체인 — Semantic Kernel IFunctionInvocationFilter의 TypeScript 구현
 *
 * 양파(onion) 패턴: 각 필터가 pre/post 로직을 수행하고 next()로 다음 필터에 위임.
 * short-circuit(next() 미호출)로 도구 실행 자체를 건너뛸 수 있음.
 *
 * 적용 범위: skill 도구만. infra/system은 시그널 기반 디스패치로 필터 미적용.
 */
import { interceptWrite } from "../approvals/interceptor.js";
import { notifyOwnerOfPending } from "../approvals/notify.js";
import {
  CHANNEL_SKILL_TOOL_NAMES,
  type AgentDependencies,
  type ToolContext,
  type ToolExecutor,
} from "../types.js";
import {
  formatZodError,
  type ToolDefinition,
} from "./tool-definition.js";
import { toErrorMessage } from "../utils/error.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("agent");

// --- 필터 타입 ---

/** 필터가 받는 컨텍스트 — 도구 호출 1건의 전체 정보 */
export interface FilterContext {
  /** 도구 이름 */
  toolName: string;
  /** tool_use 블록 ID */
  toolUseId: string;
  /** 도구 입력 (필터가 변환 가능) */
  input: Record<string, unknown>;
  /** 도구 정의 (스키마, concurrency 등) */
  definition: ToolDefinition<any> | undefined;
  /** 실행 컨텍스트 (userId, role, workspaceId) */
  context: ToolContext;
  /** 필터가 설정하는 결과 — 마지막 필터(executor)가 설정하거나 short-circuit 시 직접 설정 */
  result?: string;
  /** 에러 여부 */
  isError?: boolean;
  /** 채널 도구 실행 여부 */
  channelDelivered?: boolean;
  /** 원본 사용자 메시지 — writeInterceptFilter에서 승인 요청 컨텍스트로 사용 */
  userMessage: string;
  /** 필터 간 데이터 전달용 메타데이터 */
  metadata: Record<string, unknown>;
}

/**
 * 도구 필터 — SK IFunctionInvocationFilter와 동등
 *
 * @param ctx - 필터 컨텍스트 (읽기/쓰기 가능)
 * @param next - 다음 필터 호출. 미호출 시 short-circuit (나머지 필터 + executor 스킵)
 */
export type ToolFilter = (
  ctx: FilterContext,
  next: () => Promise<void>,
) => Promise<void>;

// --- 필터 체인 실행기 ---

/**
 * 필터 배열을 양파(onion) 순서로 실행
 *
 * 등록 순서대로 pre 실행, 역순으로 post 실행.
 * Koa compose()와 동일한 패턴.
 *
 * @param filters - 실행할 필터 배열 (순서 = 실행 순서)
 * @param ctx - 필터 컨텍스트
 */
export async function executeFilterChain(
  filters: ToolFilter[],
  ctx: FilterContext,
): Promise<void> {
  let index = 0;

  async function next(): Promise<void> {
    if (index < filters.length) {
      const filter = filters[index++]!;
      await filter(ctx, next);
    }
  }

  await next();
}

// --- 기본 필터 ---

/**
 * 로깅 필터 — 도구 실행 전후 로깅
 *
 * pre: 시작 로그. post: 결과 로그 + 소요시간.
 * 모든 skill 도구에 적용 (첫 번째 필터).
 */
export function createLoggingFilter(): ToolFilter {
  return async (ctx, next) => {
    const start = performance.now();
    log.debug("Tool call", () => ({ tool: ctx.toolName, toolUseId: ctx.toolUseId }));

    await next();

    const duration = Math.round(performance.now() - start);
    if (ctx.isError) {
      log.debug("Tool failed", () => ({ tool: ctx.toolName, duration, error: ctx.result }));
    } else {
      log.debug("Tool succeeded", () => ({ tool: ctx.toolName, duration, resultLength: ctx.result?.length ?? 0 }));
    }
  };
}

/**
 * 승인 게이트 필터 — member의 write 도구 가로채기
 *
 * interceptWrite + notifyOwnerOfPending을 자기 완결적으로 처리.
 * write concurrency + member 역할이면 short-circuit (next() 미호출).
 */
export function createWriteInterceptFilter(deps: AgentDependencies): ToolFilter {
  return async (ctx, next) => {
    // dynamic 도구의 isMutating 런타임 판별
    const isMutating = ctx.definition?.concurrency === "dynamic"
      ? ctx.definition.isMutating?.(ctx.input) ?? false
      : undefined;
    const interception = await interceptWrite(
      ctx.toolName,
      ctx.definition?.concurrency,
      ctx.input,
      ctx.context,
      deps.pendingActionStore,
      ctx.userMessage,
      isMutating,
    );

    if (interception.intercepted) {
      log.debug("Write intercepted", () => ({ tool: ctx.toolName, pendingActionId: interception.pendingAction.id }));
      // fire-and-forget 알림 — 승인 로직의 자기 완결적 처리
      notifyOwnerOfPending(
        interception.pendingAction,
        deps.registry,
        deps.workspaceStore,
      ).catch((e) => {
        log.error("Failed to notify owner of pending action", {
          pendingActionId: interception.pendingAction.id,
          error: toErrorMessage(e),
        });
      });

      ctx.result = "This operation requires the owner's approval. An approval request has been sent.";
      return; // short-circuit — next() 미호출
    }

    await next();
  };
}

/**
 * Zod 검증 필터 — 모든 skill 도구에 Zod 검증 적용
 *
 * 업계 best practice: strict 도구도 Zod 검증 통과 (이중 안전).
 * 검증 실패 시 에러를 tool result로 반환 → LLM이 수정하여 재시도.
 */
export function createZodValidationFilter(): ToolFilter {
  return async (ctx, next) => {
    const def = ctx.definition;
    if (def) {
      const parsed = def.inputSchema.safeParse(ctx.input);
      if (!parsed.success) {
        log.debug("Input validation failed", () => ({ tool: ctx.toolName, error: formatZodError(parsed.error) }));
        ctx.result = `Input validation error (please fix and retry): ${formatZodError(parsed.error)}`;
        ctx.isError = true;
        return; // short-circuit
      }
      if (def.validateInput) {
        const validation = def.validateInput(parsed.data);
        if (!validation.valid) {
          log.debug("Business validation failed", () => ({ tool: ctx.toolName, error: validation.error }));
          ctx.result = validation.error;
          ctx.isError = true;
          return; // short-circuit
        }
      }
      ctx.input = parsed.data;
    }

    await next();
  };
}

/**
 * Executor 필터 — 실제 도구 실행 (필터 체인의 마지막)
 *
 * executor를 호출하고 결과를 ctx.result에 설정.
 * 채널 도구(push_text_message 등) 실행 시 channelDelivered를 설정.
 *
 * @param executors - 현재 활성 executor 맵
 */
export function createExecutorFilter(executors: Map<string, ToolExecutor>): ToolFilter {
  return async (ctx, _next) => {
    const executor = executors.get(ctx.toolName);

    if (!executor) {
      ctx.result = `Error: Unknown tool "${ctx.toolName}"`;
      ctx.isError = true;
      return;
    }

    try {
      ctx.result = await executor(ctx.input);
      if (CHANNEL_SKILL_TOOL_NAMES.has(ctx.toolName)) {
        ctx.channelDelivered = true;
      }
    } catch (e) {
      ctx.result = `Error: ${toErrorMessage(e)}`;
      ctx.isError = true;
    }
  };
}

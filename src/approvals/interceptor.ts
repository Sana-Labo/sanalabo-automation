import { canExecute } from "../skills/gws/access.js";
import type { ToolConcurrency } from "../agent/tool-definition.js";
import type { PendingAction, PendingActionStore, ToolContext } from "../types.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("approvals");

export type InterceptResult =
  | { intercepted: true; pendingAction: PendingAction }
  | { intercepted: false };

/**
 * 도구의 동시성 속성과 역할에 기반한 쓰기 도구 가로채기
 *
 * @param toolName - 도구 이름 (로깅용)
 * @param concurrency - 도구의 동시성 특성 ({@link ToolConcurrency})
 * @param toolInput - 도구 입력
 * @param context - 실행 컨텍스트 (userId, role, workspaceId)
 * @param pendingStore - PendingAction 저장소
 * @param requestContext - 원본 사용자 메시지 (승인 요청 컨텍스트)
 */
export async function interceptWrite(
  toolName: string,
  concurrency: ToolConcurrency | undefined,
  toolInput: Record<string, unknown>,
  context: ToolContext,
  pendingStore: PendingActionStore,
  requestContext: string,
  isMutating?: boolean,
): Promise<InterceptResult> {
  const decision = canExecute(concurrency, context.role, isMutating);

  if (decision === "allow") {
    return { intercepted: false };
  }

  // 방어: workspaceId 없으면 PendingAction 생성 불가.
  // 現 코드에서는 도달 불가 (admin → canExecute "allow" → 위에서 return).
  // 향후 리팩토링 시 안전장치.
  if (!context.workspaceId) {
    log.warning("interceptWrite: no workspaceId, skipping interception", { toolName, userId: context.userId });
    return { intercepted: false };
  }

  // needs_approval — PendingAction 생성
  const pendingAction = await pendingStore.create({
    workspaceId: context.workspaceId,
    requesterId: context.userId,
    toolName,
    toolInput,
    requestContext,
  });

  return { intercepted: true, pendingAction };
}

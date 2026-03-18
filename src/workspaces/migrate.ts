import type { WorkspaceStore } from "../types.js";
import type { UserStore } from "../users/store.js";

/**
 * flat 사용자 모델에서 워크스페이스 모델로 마이그레이션한다.
 *
 * 첫 번째 시스템 관리자가 소유하는 "Default" 워크스페이스를 생성하고,
 * 기존 활성 사용자를 모두 멤버로 추가한다.
 * 워크스페이스가 이미 존재하면 무처리.
 *
 * @param userStore - 활성 사용자 목록 조회용 저장소
 * @param workspaceStore - 워크스페이스 생성 및 멤버 추가 대상 저장소
 * @param systemAdminIds - 시스템 관리자 ID 목록 (첫 번째가 오너)
 */
export async function migrateFromFlatModel(
  userStore: UserStore,
  workspaceStore: WorkspaceStore,
  systemAdminIds: string[],
): Promise<void> {
  if (workspaceStore.getAll().length > 0) return;

  const ownerId = systemAdminIds[0];
  if (!ownerId) {
    console.warn("[migrate] No system admin IDs configured, skipping migration");
    return;
  }

  console.log("[migrate] Migrating from flat user model to workspace model...");

  const workspace = await workspaceStore.create("Default", ownerId);

  // 마이그레이션된 워크스페이스는 기존 호스트 GWS 인증을 계승
  await workspaceStore.setGwsAuthenticated(workspace.id, true);

  // 기존 활성 사용자를 멤버로 추가
  const activeUsers = userStore.getActiveUsers();
  for (const userId of activeUsers) {
    if (userId === ownerId) continue; // 오너로 이미 추가됨
    await workspaceStore.inviteMember(workspace.id, userId, "system");
  }

  console.log(
    `[migrate] Created default workspace "${workspace.name}" (${workspace.id}) ` +
    `with ${activeUsers.length} user(s)`,
  );
}

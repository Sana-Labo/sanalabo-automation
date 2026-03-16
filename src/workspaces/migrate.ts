import type { WorkspaceStore } from "../types.js";
import type { UserStore } from "../users/store.js";

/**
 * Migrate from flat user model to workspace model.
 * Creates a "Default" workspace owned by the first system admin,
 * with all existing active users as members.
 * No-op if workspaces already exist.
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

  // Add existing active users as members
  const activeUsers = userStore.getActiveUsers();
  for (const userId of activeUsers) {
    if (userId === ownerId) continue; // Already added as owner
    await workspaceStore.inviteMember(workspace.id, userId, "system");
  }

  console.log(
    `[migrate] Created default workspace "${workspace.name}" (${workspace.id}) ` +
    `with ${activeUsers.length} user(s)`,
  );
}

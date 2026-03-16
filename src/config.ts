function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function requiredList(name: string): string[] {
  const ids = required(name)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    throw new Error(`${name} must contain at least one valid ID`);
  }
  return ids;
}

function requiredListWithFallback(name: string, fallback: string): string[] {
  const value = process.env[name] ?? process.env[fallback];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (or ${fallback})`);
  }
  const ids = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    throw new Error(`${name} must contain at least one valid ID`);
  }
  return ids;
}

export const config = {
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  lineChannelAccessToken: required("LINE_CHANNEL_ACCESS_TOKEN"),
  lineChannelSecret: required("LINE_CHANNEL_SECRET"),
  systemAdminIds: requiredListWithFallback("SYSTEM_ADMIN_IDS", "ADMIN_USER_IDS"),
  userStorePath: process.env["USER_STORE_PATH"] ?? "data/users.json",
  workspaceStorePath: process.env["WORKSPACE_STORE_PATH"] ?? "data/workspaces.json",
  pendingActionStorePath: process.env["PENDING_ACTION_STORE_PATH"] ?? "data/pending-actions.json",
  workspaceDataDir: process.env["WORKSPACE_DATA_DIR"] ?? "data/workspaces",
  mcpPoolSize: process.env["MCP_POOL_SIZE"] ? Number(process.env["MCP_POOL_SIZE"]) : 3,
  port: process.env["PORT"] ? Number(process.env["PORT"]) : 3000,
} as const;

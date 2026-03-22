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
  const envName = process.env[name] ? name : fallback;
  return requiredList(envName);
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
  mcpPoolSize: (() => {
    const raw = process.env["MCP_POOL_SIZE"];
    if (!raw) return 3;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error("MCP_POOL_SIZE must be a positive integer");
    }
    return n;
  })(),
  port: process.env["PORT"] ? Number(process.env["PORT"]) : 3000,

  // Google OAuth (API 전환 시 필수)
  googleClientId: process.env["GOOGLE_CLIENT_ID"] ?? "",
  googleClientSecret: process.env["GOOGLE_CLIENT_SECRET"] ?? "",
  googleRedirectUri: process.env["GOOGLE_REDIRECT_URI"] ?? "",
  tokenEncryptionKey: process.env["TOKEN_ENCRYPTION_KEY"] ?? "",
} as const;

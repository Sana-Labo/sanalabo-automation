function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** 양의 정수 환경변수 파싱. 기본값 있으면 number, 없으면 number | undefined */
function positiveInt(name: string): number | undefined;
function positiveInt(name: string, defaultValue: number): number;
function positiveInt(name: string, defaultValue?: number): number | undefined {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
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
  dataDir: process.env["DATA_DIR"] ?? "data",
  userStorePath: process.env["USER_STORE_PATH"] ?? "data/users.json",
  workspaceStorePath: process.env["WORKSPACE_STORE_PATH"] ?? "data/workspaces.json",
  pendingActionStorePath: process.env["PENDING_ACTION_STORE_PATH"] ?? "data/pending-actions.json",
  workspaceDataDir: process.env["WORKSPACE_DATA_DIR"] ?? "data/workspaces",
  mcpPoolSize: positiveInt("MCP_POOL_SIZE", 3),
  port: process.env["PORT"] ? Number(process.env["PORT"]) : 3000,

  // Agent
  agentModel: process.env["AGENT_MODEL"] ?? "claude-haiku-4-5-20251001",
  agentMaxTokens: positiveInt("AGENT_MAX_TOKENS"),
  agentMaxTurns: positiveInt("AGENT_MAX_TURNS", 15),
  agentCompactModel: process.env["AGENT_COMPACT_MODEL"] ?? "claude-sonnet-4-6",
  agentCompactMaxTokens: positiveInt("AGENT_COMPACT_MAX_TOKENS"),

  // Google OAuth (API 전환 시 필수)
  googleClientId: process.env["GOOGLE_CLIENT_ID"] ?? "",
  googleClientSecret: process.env["GOOGLE_CLIENT_SECRET"] ?? "",
  googleRedirectUri: process.env["GOOGLE_REDIRECT_URI"] ?? "",
  tokenEncryptionKey: process.env["TOKEN_ENCRYPTION_KEY"] ?? "",
} as const;

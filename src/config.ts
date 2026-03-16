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

export const config = {
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  lineChannelAccessToken: required("LINE_CHANNEL_ACCESS_TOKEN"),
  lineChannelSecret: required("LINE_CHANNEL_SECRET"),
  adminUserIds: requiredList("ADMIN_USER_IDS"),
  userStorePath: process.env["USER_STORE_PATH"] ?? "data/users.json",
  port: process.env["PORT"] ? Number(process.env["PORT"]) : 3000,
} as const;

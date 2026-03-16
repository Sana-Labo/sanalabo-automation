function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  lineChannelAccessToken: required("LINE_CHANNEL_ACCESS_TOKEN"),
  lineChannelSecret: required("LINE_CHANNEL_SECRET"),
  adminUserIds: required("ADMIN_USER_IDS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  userStorePath: process.env["USER_STORE_PATH"] ?? "data/users.json",
  port: process.env["PORT"] ? Number(process.env["PORT"]) : 3000,
} as const;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  get anthropicApiKey() {
    return required("ANTHROPIC_API_KEY");
  },
  get lineChannelAccessToken() {
    return required("LINE_CHANNEL_ACCESS_TOKEN");
  },
  get lineChannelSecret() {
    return required("LINE_CHANNEL_SECRET");
  },
  get lineUserId() {
    return required("LINE_USER_ID");
  },
  get port() {
    const raw = process.env["PORT"];
    return raw ? Number(raw) : 3000;
  },
} as const;

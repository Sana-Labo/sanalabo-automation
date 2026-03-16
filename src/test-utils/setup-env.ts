// Side-effect module: sets required environment variables for tests
// that import config.ts. Import this before any module that depends on config.
process.env.ANTHROPIC_API_KEY ??= "test-key";
process.env.LINE_CHANNEL_ACCESS_TOKEN ??= "test-token";
process.env.LINE_CHANNEL_SECRET ??= "test-secret";
process.env.SYSTEM_ADMIN_IDS ??= "Uadmin00000000000000000000000001";

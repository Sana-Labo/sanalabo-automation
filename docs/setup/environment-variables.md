# Environment Variables

All environment variables are parsed and validated in [`src/config.ts`](../../src/config.ts).
Empty-string values are treated as "not set" so schema defaults apply.

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key |
| `LINE_CHANNEL_ACCESS_TOKEN` | Yes | LINE Messaging API access token |
| `LINE_CHANNEL_SECRET` | Yes | LINE channel secret for HMAC-SHA256 signature verification |
| `SYSTEM_ADMIN_IDS` | Yes | System admin LINE userIds (comma-separated) |
| `GOOGLE_CLIENT_ID` | GWS only | Google Cloud OAuth 2.0 Client ID |
| `GOOGLE_CLIENT_SECRET` | GWS only | Google Cloud OAuth 2.0 Client Secret |
| `GOOGLE_REDIRECT_URI` | GWS only | OAuth redirect URI — must match the value in Google Cloud Console |
| `VAULT_AGENT_URL` | GWS only | vault-agent sidecar URL (default: `http://vault-agent:8100`) — app delegates at-rest OAuth token encryption to Vault Transit via this proxy |
| `VAULT_TRANSIT_KEY` | No | Vault Transit key name (default: `tokens`) |
| `PORT` | No | Server port (default: `3000`) |
| `MCP_POOL_SIZE` | No | MCP connection pool size (default: `3`) |
| `AGENT_MODEL` | No | Agent model ID (default: `claude-haiku-4-5-20251001`) |
| `AGENT_MAX_TOKENS` | No | Max tokens per turn — auto-queried from Models API if unset |
| `AGENT_MAX_TURNS` | No | Max tool-call turns per session (default: `15`) |
| `AGENT_MAX_TOKEN_RETRIES` | No | Auto-resume count on `max_tokens` stop reason (default: `3`) |
| `AGENT_COMPACT_MODEL` | No | *(planned)* Model used for context compaction (default: `claude-sonnet-4-6`) |
| `AGENT_COMPACT_MAX_TOKENS` | No | *(planned)* Max tokens for compaction — auto-queried from Models API if unset |
| `LOG_LEVEL` | No | `debug` / `info` / `warning` / `error` (default: `info`) |
| `USER_STORE_PATH` | No | User store file path (default: `data/users.json`) |
| `WORKSPACE_STORE_PATH` | No | Workspace store file path (default: `data/workspaces.json`) |
| `PENDING_ACTION_STORE_PATH` | No | Pending action store file path (default: `data/pending-actions.json`) |
| `WORKSPACE_DATA_DIR` | No | Workspace data directory (default: `data/workspaces`) |

---

## Notes

### Docker `.env` quirks

- **Do not use inline comments** on the same line as a value — Docker Compose reads everything after `=` including `#` as part of the value.
- After editing `.env`, apply changes with `docker compose up -d`. `docker compose restart` will **not** pick up new values.

### Secrets handling

- Never commit `.env`. Both `.env` and `.env.*.local` are in `.gitignore`.
- OAuth refresh tokens are encrypted via Vault Transit through the vault-agent sidecar. AppRole rotation (the `VAULT_SECRET_ID` in Vault KV) is transparent — the agent re-auths on the next deploy. Rotating the Transit key itself via `vault write -f transit/keys/tokens/rotate` keeps existing ciphertexts valid (Vault embeds the key version).
- `LINE_CHANNEL_SECRET` must match the value shown in the LINE Developers Console — mismatch causes all Webhook signatures to fail verification.

# sanalabo-automation

> **v1.0.0** — Initial release

An agent server that operates Google Workspace through Claude API's tool_use.
Uses LINE as the user input channel with a workspace-based multi-tenant architecture.

## Architecture

```
[LINE Bot] ←→ [Webhook + Event Router]
                       │
              ┌────────┴────────┐
              ▼                  ▼
      [Workspace A]       [Workspace B]
      Owner + Members     Owner + Members
              │                  │
      ┌───────┴───────┐         │
      ▼               ▼         ▼
 [Agent Loop]    [Agent Loop]  [Agent Loop]
      │               │         │
 ┌────┴───────────────┴─────────┘
 ▼                            ▼
[GWS Executor]         [MCP Pool (N=3)]
(per-workspace)        LINE Push API
 │
[gws CLI + Google API]
```

### Key Concepts

| Term | Description |
|------|-------------|
| **Workspace** | A unit of GWS account + member group |
| **Owner** | Workspace owner with full GWS read/write access |
| **Member** | Workspace member with read access; write operations require Owner approval |
| **System Admin** | System-wide administrator responsible for workspace provisioning |

### Agent Core

Not an intent router but an **agent loop** — Claude autonomously decides which tools to invoke.

- **Google Workspace**: Native Tool (`Bun.spawn` → GWS CLI)
- **LINE Messaging**: MCP Tool (via `@line/line-bot-mcp-server`)

Write operations by Members go through the Owner's approval flow (PendingAction).

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | [Bun](https://bun.sh/) |
| Framework | [Hono](https://hono.dev/) |
| Language | TypeScript (strict mode, ESM) |
| AI | `@anthropic-ai/sdk` — tool_use based agent loop |
| GWS | `@googleworkspace/cli` — Native Tool (`Bun.spawn`) |
| LINE | `@line/line-bot-mcp-server` — MCP Tool |
| MCP Transport | Connection Pool (N stdio processes, least-inflight dispatch) |
| Scheduler | [Croner](https://github.com/hexagon/croner) |
| Deploy | Docker Compose (`oven/bun:alpine`) |
| Tunnel | Cloudflare Tunnel |

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) v1.0+
- [Docker](https://www.docker.com/) & Docker Compose
- Google Workspace CLI (`gws`) — `npm install -g @googleworkspace/cli`
- LINE Bot channel (Messaging API)
- Claude API key

### Setup

```bash
# 1. Install dependencies
bun install

# 2. Configure environment
cp .env.example .env
# Edit .env with your API keys

# 3. Run in development
bun run dev

# 4. Run tests
bun test

# 5. Type check
bun run typecheck
```

### Docker Deployment

```bash
# Build and start
docker compose up -d

# GWS authentication (per workspace)
docker exec -it assistant gws auth login --config-dir data/workspaces/{id}/gws-config/
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key |
| `LINE_CHANNEL_ACCESS_TOKEN` | Yes | LINE Messaging API access token |
| `LINE_CHANNEL_SECRET` | Yes | LINE channel secret for signature verification |
| `SYSTEM_ADMIN_IDS` | Yes | System admin LINE userIds (comma-separated) |
| `CF_TUNNEL_TOKEN` | Yes | Cloudflare Tunnel token |
| `PORT` | No | Server port (default: 3000) |
| `MCP_POOL_SIZE` | No | MCP connection pool size (default: 3) |
| `USER_STORE_PATH` | No | User store file path (default: `data/users.json`) |
| `WORKSPACE_STORE_PATH` | No | Workspace store file path (default: `data/workspaces.json`) |
| `PENDING_ACTION_STORE_PATH` | No | Pending action store file path (default: `data/pending-actions.json`) |
| `WORKSPACE_DATA_DIR` | No | Workspace data directory (default: `data/workspaces`) |

## Project Structure

```
src/
├── channels/line.ts          # LINE Webhook (signature verification, event parsing)
├── agent/
│   ├── loop.ts               # tool_use agent loop
│   ├── system.ts             # System prompt (workspace + role aware)
│   ├── system-tools.ts       # System Tools (workspace CRUD via agent)
│   ├── mcp.ts                # MCP client singleton
│   └── mcp-pool.ts           # MCP connection pool (least-inflight dispatch)
├── users/store.ts            # User store (invite → active → inactive)
├── workspaces/
│   ├── store.ts              # Workspace store (CRUD, member management)
│   └── migrate.ts            # Flat → workspace migration
├── approvals/
│   ├── store.ts              # PendingAction store
│   ├── interceptor.ts        # Write interception (member → owner approval)
│   └── notify.ts             # Owner notification (Flex/Text message)
├── skills/gws/
│   ├── tools.ts              # Tool definitions (JSON Schema)
│   ├── executor.ts           # GWS CLI execution + caching
│   └── access.ts             # Access control (read/write classification)
├── jobs/index.ts             # Cron jobs (morning briefing, urgent mail, etc.)
├── routes/
│   ├── lineWebhook.ts        # POST /webhook/line
│   └── health.ts             # GET /health
├── utils/
│   ├── json-file-store.ts    # Abstract JSON file store base class
│   └── error.ts              # Error utilities
├── test-utils/               # Shared test helpers
│   ├── setup-env.ts          # Test environment variables
│   └── tmpdir.ts             # Temporary directory management
├── scheduler.ts              # Croner registration
├── config.ts                 # Environment variable parsing
├── app.ts                    # Hono entrypoint
└── types.ts                  # Shared types + Store interfaces
```

## Workspace Management

Workspaces are managed through **System Tools** via the LINE agent conversation:

- `create_workspace` — Create a new workspace (1 per user). Admins can specify `owner_user_id`
- `list_workspaces` — List workspaces (admin: all, regular user: owned only)
- `get_workspace_info` — View workspace details (admin: any, regular user: owned only)

## Testing

```bash
bun test                              # Run all tests
bun test src/utils/error.test.ts      # Run a specific test file
```

Tests are co-located with source files (`*.test.ts`). The project follows TDD methodology.

| Category | Tests | Strategy |
|----------|-------|----------|
| Pure logic | access, error, LINE parsing, system prompt | Direct calls, no mocks |
| Store I/O | JsonFileStore, UserStore, WorkspaceStore, PendingActionStore | Real file I/O with temp dirs |
| Business logic | interceptor, notifications, executor caching | Mock stores/registries |
| HTTP | health route | Hono `app.request()` |

## Safety Rules

1. **No automatic email sending** — only draft creation allowed
2. **Calendar events require confirmation** — present to user before execution
3. **GWS CLI via `Bun.spawn` only** (shell: false) — prevents shell injection
4. **LINE Webhook signature verification required** — HMAC-SHA256 via Web Crypto API
5. **Agent loop iteration limit** — prevents infinite tool call loops
6. **Active users only** — inactive/uninvited users are rejected
7. **Deterministic command handling** — invite/approve commands use pattern matching, not Claude
8. **Workspace data isolation** — per-workspace GWS configDir
9. **LINE push user_id enforcement** — programmatically injected, not Claude-dependent

## Contributing

### Branch Strategy

All work is done on **feature branches** — direct commits to `main` are prohibited.

```
main (protected)
 ├── feature/description   — new features
 ├── fix/description       — bug fixes
 ├── docs/description      — documentation
 ├── chore/description     — maintenance tasks
 ├── test/description      — test additions/changes
 └── refactor/description  — code refactoring
```

**Rules**:
- Branch from `main`, merge back to `main`
- Use **squash and merge** via GitHub PR (linear history)
- Delete feature branches after merge
- Keep branches short-lived (one task per branch)

### Commit Convention

[Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>(<scope>): <description>
```

**Types**: `feat`, `fix`, `docs`, `chore`, `test`, `refactor`, `style`, `perf`, `ci`

**Scopes**: `agent`, `channel`, `skill`, `jobs`, `routes`, `config`, `workspaces`, `approvals`, `docker`

**Examples**:
```
feat(agent): add retry logic to agent loop
fix(channel): handle empty webhook body
docs(readme): add contributing guidelines
test(approvals): add interceptor edge case tests
refactor(skill): extract common GWS error handling
```

**Rules**:
- 1 task = 1 commit (each commit should be independently cherry-pickable)
- Never commit secrets (`.env`, credentials)
- Never use `git add -A` or `git add .` — stage specific files

### Pull Request Workflow

1. Create a feature branch from `main`
2. Make changes and commit
3. Push and create a PR
4. PR review + approval required
5. Squash and merge into `main` (linear history)
6. Delete the feature branch

### Verification Before Merge

```bash
bun run typecheck    # Must pass
bun test             # Must pass (all 130+ tests)
```

## Claude Code Integration

This project includes `.claude/CLAUDE.md` with project-specific instructions for [Claude Code](https://claude.com/claude-code) collaboration. Contributors using Claude Code will automatically receive project context, coding conventions, and safety rules.

## License

Private — Sana Labo

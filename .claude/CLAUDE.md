# sanalabo-automation

Claude API의 tool_use를 활용하여 Google Workspace를 조작하는 에이전트 서버.
LINE을 사용자 입력 채널로 사용하며, 추후 채널 및 스킬을 확장할 수 있는 구조.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Bun |
| Framework | Hono |
| Language | TypeScript (strict mode, ESM) |
| AI | `@anthropic-ai/sdk` — tool_use 기반 에이전트 루프 |
| GWS Skill | GWS CLI (`@googleworkspace/cli`) — Native Tool (`Bun.spawn`) |
| LINE Skill | `@line/line-bot-mcp-server` — MCP Tool (메시지 발신) |
| LINE Channel | SDK-free (Web Crypto + native fetch) — Webhook 수신 전용 |
| Scheduler | Croner (Bun 공식 지원, 0 의존성) |
| Deploy | Docker Compose (`oven/bun:alpine`) on MacBook Pro M4 Pro |
| Tunnel | Cloudflare Tunnel — LINE Webhook 수신용 |

## Architecture

```
[사용자 LINE 앱]
    ↕ 메시지
[LINE Platform]
    ↓ Webhook POST (수신)              ↑ 발신 (MCP 경유)
┌──────────────────────────────────────────────────────┐
│  Channel Layer                                        │
│  └── LINE Webhook 수신 + signature 검증 (Web Crypto)  │
├──────────────────────────────────────────────────────┤
│  Agent Core (Claude API + tool_use loop)               │
│                                                        │
│  Claude가 보는 도구 목록 (실행 경로를 모름):              │
│  ├── gmail_list, gmail_search, ...    ← Native Tool    │
│  ├── calendar_list, calendar_create   ← Native Tool    │
│  ├── push_text_message                ← MCP Tool       │
│  └── push_flex_message                ← MCP Tool       │
│                                                        │
│  도구 실행 라우팅:                                       │
│  ├── Native Tool → Bun.spawn(["gws", ...])             │
│  └── MCP Tool    → MCP Client → LINE MCP Server        │
├──────────────────────────────────────────────────────┤
│  @line/line-bot-mcp-server (외부 프로세스, stdio)       │
└──────────────────────────────────────────────────────┘
```

### 핵심 개념

| 용어 | 정의 | 예시 |
|------|------|------|
| **Skill** | 능력의 묶음 (도메인 단위) | Google Workspace 조작, LINE 메시징 |
| **Tool** | 스킬 안의 개별 조작 (Claude가 tool_use로 호출하는 단위) | `gmail_search`, `push_text_message` |
| **Native Tool** | 에이전트가 직접 실행하는 도구 | GWS CLI → `Bun.spawn` |
| **MCP Tool** | MCP Server를 경유하여 실행하는 도구 | LINE MCP Server → `push_text_message` |

Claude는 Native Tool과 MCP Tool의 차이를 모른다. 둘 다 동일한 tool_use로 호출.

### 스킬 구성

| Skill | 구현 방식 | Tools | 이유 |
|-------|----------|-------|------|
| Google Workspace | Native Tool (`Bun.spawn` → GWS CLI) | `gmail_*`, `calendar_*`, `drive_*` | 외부 재사용 불필요, CLI 래핑으로 충분 |
| LINE 메시징 | MCP Tool (`@line/line-bot-mcp-server`) | `push_text_message`, `push_flex_message` 등 | 에이전트가 자율적으로 발신 판단 |

### LINE 통신의 역할 분리

| 역할 | 위치 | 구현 |
|------|------|------|
| **수신** (Webhook) | Channel Layer | Hono + Web Crypto signature 검증 |
| **발신** (메시지 전송) | Skill Layer (MCP) | 에이전트가 LINE MCP Server 도구로 자율 발신 |

### Agent Core 동작 방식

Intent router가 아닌 **에이전트 루프** — Claude가 어떤 도구를 호출할지 자율 판단.

```
Channel input
  → Claude API (system prompt + tools 정의 + 사용자 메시지)
  → while stop_reason === 'tool_use':
      → 도구 실행 (Native Tool 또는 MCP Tool)
      → 결과를 대화에 추가
      → Claude API 재호출
  → stop_reason === 'end_turn': 최종 응답
```

- Claude가 도구를 체이닝할 수 있음 (예: "메일 확인 → 관련 일정 찾기 → LINE으로 요약 발신")
- 새 스킬 추가 = 도구 정의 + 실행 구현 추가 (Agent Core 코드 변경 불필요)

### Cron 잡 (자동 통지)

| Schedule | Job | 내용 |
|----------|-----|------|
| `0 8 * * 1-5` | morningBriefing | 미독 메일 요약 + 오늘 일정 |
| `*/30 8-22 * * *` | urgentMailCheck | 긴급 메일 LINE 통지 |
| `0 21 * * 1-5` | eveningSummary | 오늘 활동 요약 + 내일 일정 |

Cron 잡도 Agent Core를 호출하여 실행 — 에이전트가 GWS 도구로 정보 수집 후 LINE MCP 도구로 발신.

## Project Structure

```
src/
├── channels/              # 입력 채널 어댑터
│   └── line.ts            # LINE Webhook 수신 + signature 검증 (Web Crypto)
├── agent/                 # 에이전트 코어
│   ├── loop.ts            # tool_use 에이전트 루프
│   ├── mcp.ts             # MCP Client (LINE MCP Server 연결)
│   └── system.ts          # 시스템 프롬프트
├── skills/                # 스킬 구현
│   ├── gws/               # Google Workspace 스킬
│   │   ├── tools.ts       # 도구 정의 (JSON Schema)
│   │   └── executor.ts    # 실행 (Bun.spawn → GWS CLI)
│   └── line/              # LINE 메시징 스킬
│       └── (MCP Server 연결 — 도구 정의는 MCP가 자기 기술)
├── jobs/                  # Cron 잡
│   ├── morningBriefing.ts
│   ├── urgentMailCheck.ts
│   └── eveningSummary.ts
├── routes/                # Hono 라우트
│   ├── lineWebhook.ts     # POST /webhook/line
│   └── health.ts          # GET /health
├── scheduler.ts           # Croner 등록
├── app.ts                 # Hono 엔트리포인트
└── types.ts
```

## Safety Rules (위반 금지)

1. **메일 자동 발송 절대 금지** — 하서 작성만 허용. 발송은 사용자가 Gmail에서 직접 수행
2. **캘린더 추가 시 확인 필수** — 추가 내용을 LINE으로 제시한 후 실행
3. **GWS CLI는 `Bun.spawn` (shell: false)만 사용** — shell injection 방지
4. **LINE Webhook은 반드시 signature 검증** — Web Crypto API로 HMAC-SHA256 검증. 미검증 요청 처리 금지
5. **에이전트 루프 무한 반복 방지** — 도구 호출 최대 횟수 제한 설정 필수

## AI Model 사용 규칙

| 용도 | 모델 | 이유 |
|------|------|------|
| Agent loop (기본) | `claude-haiku-4-5-20251001` | 저비용, 고속, tool_use 지원 |
| 복잡한 판단 | `claude-sonnet-4-6` | 필요 시에만 사용 |

- 모델 ID는 위 표의 값을 정확히 사용할 것
- 새 모델 추가 시 이 파일을 먼저 갱신

## Coding Conventions

### TypeScript
- strict mode + ESM (`"type": "module"`)
- 공통 타입은 `src/types.ts`에 정의

### LINE Webhook 수신 (Channel Layer, SDK-free)
- signature 검증: `crypto.subtle.verify()` (Web Crypto API, timing-safe)
- raw body 보존: signature 검증 전 body 파싱/변환 금지

### LINE 메시지 발신 (Skill Layer, MCP)
- 에이전트가 LINE MCP Server 도구로 자율 발신
- 에이전트 시스템 프롬프트에 메시지 포맷 규칙 포함:
  - 2000자 이내 (간결하게)
  - 줄바꿈으로 가독성 확보

### GWS CLI 호출
- 모든 명령에 `--format json` 플래그 사용
- 타임아웃 30초 설정
- 호스트에서 `gws auth login`으로 사전 인증된 상태 전제

### 스킬 추가 규칙
- Native Tool: `skills/<name>/tools.ts` (도구 정의) + `executor.ts` (실행 구현)
- MCP Tool: `agent/mcp.ts`에 MCP Server 연결 추가 (도구 정의는 MCP Server가 제공)
- Agent Core 수정 불필요

## Environment Variables

`.env.example` 참조. 필수 변수:

| 변수 | 용도 |
|------|------|
| `ANTHROPIC_API_KEY` | Claude API |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE MCP Server + Webhook 검증용 |
| `LINE_CHANNEL_SECRET` | LINE signature 검증 |
| `LINE_USER_ID` | Push 메시지 대상 |
| `PORT` | 서버 포트 (기본 3000) |
| `CF_TUNNEL_TOKEN` | Cloudflare Tunnel |

## Verification Commands

```bash
bun run dev          # 개발 서버 (HMR)
bun run build        # 타입 체크 (bun build)
bun start            # 프로덕션 실행
bun test             # 테스트 (bun 내장 테스트 러너)
docker compose up -d # Docker 프로덕션 배포
```

- 코드 변경 후 타입 체크 통과 필수
- Docker 이미지: `oven/bun:alpine` 기반

## Branch Strategy

- 글로벌 `rules/github-vc.md` 기본값 적용
- 작업 브랜치: `feature/*`, `fix/*`, `docs/*`

## Commit Convention

- Conventional Commits: `<type>(<scope>): <제목>`
- scope: `agent`, `channel`, `skill`, `jobs`, `routes`, `config` 등 계층/모듈 단위

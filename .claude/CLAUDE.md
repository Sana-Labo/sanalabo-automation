# sanalabo-automation (v1.0.0)

Claude API의 tool_use를 활용하여 Google Workspace를 조작하는 에이전트 서버.
LINE을 사용자 입력 채널로 사용하며, 워크스페이스 기반 다중 테넌트 아키텍처.

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
| MCP Transport | Connection Pool (N개 stdio 프로세스, least-inflight 디스패치) |
| Logging | LogTape (`@logtape/logtape`) — 0 의존성, 구조화 로깅, 환경변수 레벨 제어 |
| Scheduler | Croner (Bun 공식 지원, 0 의존성) |
| Deploy | Docker Compose (`oven/bun:alpine`) on MacBook Pro M4 Pro |
| Tunnel | Cloudflare Tunnel — LINE Webhook 수신용 |

## Architecture

```
[System Admin]──관리 명령──┐
                            ▼
[LINE Bot (단일 채널)] ←──→ [Webhook + Event Router]
                                    │
                           ┌────────┴────────┐
                           ▼                  ▼
                   [Workspace A]       [Workspace B]
                   Owner: UserA        Owner: UserC
                   Members: N명        Members: M명
                   GWS: A's Google     GWS: C's Google
                           │                  │
                   ┌───────┴───────┐          │
                   ▼               ▼          ▼
              [Agent Loop]    [Agent Loop]  [Agent Loop]
              context: {      context: {   context: {
                ws: A,          ws: A,       ws: B,
                role: owner,    role: member, role: owner,
                userId: A       userId: B    userId: C
              }               }            }
                   │               │          │
           ┌───────┴───────────────┴──────────┘
           ▼                               ▼
    [GWS Executor]                  [MCP Pool (N=3)]
    (per-workspace                  [Member 0] [Member 1] [Member 2]
     configDir)                     least-inflight dispatch
           │                               │
    [gws CLI + Google API]          [LINE Push API]
```

### 역할 체계

| 역할 | 범위 | GWS 접근 | 관리 권한 |
|------|------|----------|----------|
| **System Admin** | 전체 시스템 | — (워크스페이스 소속 불필요) | 워크스페이스 프로비저닝 (CLI/LINE), 모니터링 |
| **Owner** | 1 워크스페이스 | 읽기 + 쓰기 (본인 Google 계정) | LINE에서 멤버 초대/제거 |
| **Member** | 1+ 워크스페이스 | 읽기 O, 쓰기 → Owner 승인 필요 | — |

### 핵심 개념

| 용어 | 정의 | 예시 |
|------|------|------|
| **Workspace** | GWS 계정 + 멤버 그룹의 단위 | 동아리 A의 Google 계정 |
| **Skill** | 능력의 묶음 (도메인 단위) | Google Workspace 조작, LINE 메시징 |
| **Tool** | 스킬 안의 개별 조작 (Claude가 tool_use로 호출하는 단위) | `gmail_list`, `push_text_message` |
| **Native Tool** | 에이전트가 직접 실행하는 도구 | GWS CLI → `Bun.spawn` |
| **MCP Tool** | MCP Server를 경유하여 실행하는 도구 | LINE MCP Server → `push_text_message` |

Claude는 Native Tool과 MCP Tool의 차이를 모른다. 둘 다 동일한 tool_use로 호출.

### 스킬 구성

| Skill | 구현 방식 | Tools | 이유 |
|-------|----------|-------|------|
| Google Workspace | Native Tool (`Bun.spawn` → GWS CLI) | `gmail_*`, `calendar_*`, `drive_*` | 워크스페이스별 configDir로 격리 |
| LINE 메시징 | MCP Tool (`@line/line-bot-mcp-server`) | `push_text_message`, `push_flex_message` 등 | MCP Pool 경유 |

### LINE 통신의 역할 분리

| 역할 | 위치 | 구현 |
|------|------|------|
| **수신** (Webhook) | Channel Layer | Hono + Web Crypto signature 검증 |
| **발신** (메시지 전송) | Skill Layer (MCP Pool) | 에이전트가 LINE MCP Server 도구로 자율 발신 |

### Agent Core 동작 방식

Intent router가 아닌 **에이전트 루프** — Claude가 어떤 도구를 호출할지 자율 판단.

```
Webhook event
  → resolveWorkspace(userId) → ToolContext { userId, workspaceId, role }
  → getGwsExecutors(workspace.id, workspace.gwsConfigDir)
  → Claude API (system prompt + tools 정의 + 사용자 메시지)
  → while stop_reason === 'tool_use':
      → interceptWrite() — member의 write 도구 → PendingAction 생성 + Owner 통지
      → 또는 도구 실행 (GWS executor 또는 MCP Pool)
      → 결과를 대화에 추가
      → Claude API 재호출
  → stop_reason === 'end_turn': 최종 응답
```

### Write Approval Flow (Member → Owner)

1. Member가 write 도구 호출 → `interceptWrite()` 가로채기
2. `PendingAction` 생성 → Owner에게 Flex Message (Approve/Reject 버튼)
3. Owner가 postback 또는 `approve {id}` 텍스트로 승인
4. 원래 도구 실행 → 양측에 결과 통지

### MCP Connection Pool

- N개(기본 3) MCP 클라이언트 프로세스 풀
- **Least-inflight 디스패치**: 가장 여유 있는 멤버에 라우팅
- **멤버별 격리 재연결**: 한 멤버 장애가 다른 멤버 차단하지 않음
- **헬스 체크**: 30초 간격 ping, 3회 연속 실패 → unhealthy → 백그라운드 재연결
- Health 엔드포인트에서 풀 상태 노출

### Cron 잡 (자동 통지)

| Schedule | Job | 내용 |
|----------|-----|------|
| `0 8 * * 1-5` | morningBriefing | 미독 메일 요약 + 오늘 일정 |
| `*/30 8-22 * * *` | urgentMailCheck | 긴급 메일 LINE 통지 |
| `0 21 * * 1-5` | eveningSummary | 오늘 활동 요약 + 내일 일정 |
| `0 * * * *` | pendingActionExpiry | 24시간 경과 PendingAction 만료 |

Cron 잡은 워크스페이스별 → 멤버별로 순회. 각 멤버의 ToolContext(workspaceId, role)로 Agent Core 호출.

### Webhook 동시성

- **사용자별 큐**: 같은 사용자 내 순차 처리 (대화 순서 보장), 다른 사용자 간 병렬 실행
- JS 단일 스레드 이벤트 루프에서 `Map` 접근 경쟁 없음
- 큐 드레인 후 자동 정리 (메모리 누수 방지)

### 사용자 관리 + 워크스페이스

**사용자 상태**:

| 상태 | 설명 | 전이 |
|------|------|------|
| `invited` | Owner가 초대 완료, 미가입 | follow 이벤트 → `active` |
| `active` | 서비스 이용 중 | unfollow 이벤트 → `inactive` |
| `inactive` | 탈퇴 (블록) | — |

**초대 플로우**:
1. Owner가 LINE에서 `invite U[0-9a-f]{32}` 전송
2. 시스템이 결정론적으로 매칭 → UserStore + WorkspaceStore에 등록
3. 초대된 사용자가 LINE 공식 계정을 친구 추가 (follow 이벤트)
4. 시스템이 `invited` → `active` 전환 + 환영 메시지

**워크스페이스 해결**: 단일 소속 → 자동, 복수 → `defaultWorkspaceId` 또는 `use {id}` 명령

**시스템 관리자**: `SYSTEM_ADMIN_IDS` 환경변수로 지정. 시작 시 자동 `active` 등록.

## Project Structure

```
src/
├── channels/              # 입력 채널 어댑터
│   └── line.ts            # LINE Webhook 수신 + signature 검증 (Web Crypto)
├── agent/                 # 에이전트 코어
│   ├── loop.ts            # tool_use 에이전트 루프 (AgentDependencies + ToolContext)
│   ├── mcp.ts             # MCP 공유 프리미티브 (연결, 환경변수, 도구 필터링)
│   ├── mcp-pool.ts        # MCP Connection Pool (least-inflight dispatch)
│   └── system.ts          # 시스템 프롬프트 (워크스페이스 + 역할 인식)
├── users/                 # 사용자 관리
│   └── store.ts           # JSON 파일 기반 사용자 저장소
├── workspaces/            # 워크스페이스 관리
│   ├── store.ts           # JSON 파일 기반 워크스페이스 저장소
│   ├── migrate.ts         # flat → workspace 자동 마이그레이션
│   └── cli.ts             # 프로비저닝 CLI (create/list/status)
├── approvals/             # Write 승인 플로우
│   ├── store.ts           # PendingAction 저장소
│   ├── interceptor.ts     # Write 가로채기 (member 권한 체크)
│   └── notify.ts          # Owner 통지 (Flex Message)
├── skills/                # 스킬 구현
│   └── gws/               # Google Workspace 스킬
│       ├── tools.ts       # 도구 정의 (JSON Schema)
│       ├── executor.ts    # 실행 (Bun.spawn + GwsExecOptions)
│       └── access.ts      # 접근 제어 (read/write 분류)
├── jobs/                  # Cron 잡 (워크스페이스별 순회)
│   └── index.ts           # morningBriefing, urgentMailCheck, eveningSummary
├── routes/                # Hono 라우트
│   ├── lineWebhook.ts     # POST /webhook/line (워크스페이스 해결, 승인 처리)
│   └── health.ts          # GET /health (MCP Pool 상태 포함)
├── utils/                 # 공통 유틸리티
│   ├── error.ts           # toErrorMessage
│   └── json-file-store.ts # JSON 파일 기반 범용 저장소
├── test-utils/            # 테스트 유틸리티
│   ├── setup-env.ts       # 테스트용 환경변수 설정
│   └── tmpdir.ts          # 테스트용 임시 디렉터리 관리
├── config.ts              # 환경변수 로딩 + 검증
├── scheduler.ts           # Croner 등록 (워크스페이스별 순회 + 만료 cron)
├── app.ts                 # Hono 엔트리포인트 + 마이그레이션
└── types.ts               # 공통 타입 + Store 인터페이스
```

## Safety Rules (위반 금지)

1. **메일 자동 발송 절대 금지** — 초안(draft) 작성만 허용. 발송은 사용자가 Gmail에서 직접 수행
2. **캘린더 추가 시 확인 필수** — 추가 내용을 LINE으로 제시한 후 실행
3. **GWS CLI는 `Bun.spawn` (shell: false)만 사용** — shell injection 방지
4. **LINE Webhook은 반드시 signature 검증** — Web Crypto API로 HMAC-SHA256 검증. 미검증 요청 처리 금지
5. **에이전트 루프 무한 반복 방지** — 도구 호출 최대 횟수 제한 설정 필수
6. **사용자 권한 확인 필수** — 활성(`active`) 사용자만 에이전트 루프 실행. 미초대/비활성 사용자 요청은 무시 또는 안내 메시지
7. **초대/승인 명령은 결정론적 처리** — 패턴 매칭. Claude 판단에 의존하지 않음
8. **GWS 데이터는 워크스페이스 단위 격리** — 워크스페이스별 GWS configDir. Member의 write는 Owner 승인 필요
9. **LINE push user_id는 프로그래밍적 보장** — 시스템 프롬프트 지시 + `push_` 도구 실행 전 코드에서 강제 주입. Claude 출력에 의존하지 않음

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
- Store 인터페이스도 `src/types.ts`에 선언 (순환 의존 방지)

### 주석 규격 (Comment Convention)

- **언어**: 한국어(기본) > 영어. 코드 식별자 및 기술 용어는 영어 유지
- **형식**: TSDoc/JSDoc 표준 (`/** */` 블록)
  - export되는 함수, 클래스, 인터페이스, 타입에 `/** */` 문서화 주석 필수
  - `@param`, `@returns`, `@throws` 등 TSDoc 태그 사용
  - 내부 구현 설명은 `//` 인라인 주석 허용
- **기존 주석 포함**: 기존 영어 주석도 한국어 + TSDoc 형식으로 갱신 대상

### LINE Webhook 수신 (Channel Layer, SDK-free)
- signature 검증: `crypto.subtle.verify()` (Web Crypto API, timing-safe)
- raw body 보존: signature 검증 전 body 파싱/변환 금지

### LINE 메시지 발신 (Skill Layer, MCP Pool)
- 에이전트가 LINE MCP Server 도구로 자율 발신
- MCP Pool 경유 (least-inflight 디스패치)
- 에이전트 시스템 프롬프트에 메시지 포맷 규칙 포함:
  - 2000자 이내 (간결하게)
  - 줄바꿈으로 가독성 확보
- 에이전트 응답 언어 정책:
  - 사용자가 특정 언어로 작성하면 동일 언어로 응답
  - 자동 알림(cron/follow/invite) 및 언어 불확실 시 영어 기본값
  - 프롬프트(시스템/cron/webhook)는 영어로 작성 (Claude 인식 최적화)

### GWS CLI 호출
- 모든 명령에 `--format json` 플래그 사용
- 타임아웃 30초 설정
- `GWS_CONFIG_DIR` 환경변수로 워크스페이스별 인증 경로 전달
- 워크스페이스별 `gws auth login --config-dir {path}`으로 사전 인증

### 스킬 추가 규칙
- Native Tool: `skills/<name>/tools.ts` (도구 정의) + `executor.ts` (실행 구현) + `access.ts` (접근 제어)
- MCP Tool: `agent/mcp.ts`에 MCP Server 연결 추가 (도구 정의는 MCP Server가 제공)
- Agent Core 수정 불필요

### Testing (TDD)

- **방법론**: TDD 준수 — 새 기능/수정 시 테스트 선행 (Red → Green → Refactor)
- **러너**: `bun:test` (Bun 내장, 추가 의존성 불필요)
- **파일 배치**: 소스 파일과 동일 디렉터리에 `*.test.ts` (co-location)
- **네이밍**: `describe("모듈명")` > `test("동작 설명")`
- **테스트 분류**:

| 분류 | 대상 | 전략 |
|------|------|------|
| 순수 로직 | access, error, event parsing, system prompt | 직접 호출, mock 불필요 |
| Store I/O | JsonFileStore, UserStore, WorkspaceStore, PendingActionStore | 임시 파일 (`$TMPDIR`), 실제 I/O |
| 비즈니스 로직 | interceptor, notify, executor caching | Store/Registry mock |
| HTTP | health route | `app.request()` (Hono 내장) |

- **검증 기준**: 코드 변경 후 `bun run typecheck` + `bun test` 모두 통과 필수

### 워크스페이스 프로비저닝 (시스템 관리자)
1. CLI: `bun run src/workspaces/cli.ts create "이름" Uowner...`
2. 또는 LINE: `create-workspace 이름 Uowner...`
3. GWS 인증: `docker exec -it assistant gws auth login --config-dir data/workspaces/{id}/gws-config/`

## Environment Variables

`.env.example` 참조. 필수 변수:

| 변수 | 용도 |
|------|------|
| `ANTHROPIC_API_KEY` | Claude API |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE MCP Server (메시지 발신) |
| `LINE_CHANNEL_SECRET` | LINE signature 검증 |
| `SYSTEM_ADMIN_IDS` | 시스템 관리자 LINE userId (콤마 구분, `ADMIN_USER_IDS` 폴백) |
| `PORT` | 서버 포트 (기본 3000, optional) |
| `USER_STORE_PATH` | 사용자 저장소 경로 (기본 `data/users.json`, optional) |
| `WORKSPACE_STORE_PATH` | 워크스페이스 저장소 경로 (기본 `data/workspaces.json`, optional) |
| `PENDING_ACTION_STORE_PATH` | 승인 저장소 경로 (기본 `data/pending-actions.json`, optional) |
| `WORKSPACE_DATA_DIR` | 워크스페이스 데이터 디렉터리 (기본 `data/workspaces`, optional) |
| `MCP_POOL_SIZE` | MCP 풀 크기 (기본 3, optional) |
| `LOG_LEVEL` | 로그 레벨: `debug`/`info`/`warning`/`error` (기본 `info`, optional) |
| `DEBUG` | `1` 또는 `true` → debug 레벨 활성화 (`LOG_LEVEL` 우선, optional) |
| `CF_TUNNEL_TOKEN` | Cloudflare Tunnel |

## Verification Commands

```bash
bun run dev          # 개발 서버 (HMR)
bun run typecheck    # 타입 체크 (tsc --noEmit)
bun start            # 프로덕션 실행
bun test             # 테스트 (bun 내장 테스트 러너)
docker compose up -d # Docker 프로덕션 배포
```

```bash
# 워크스페이스 관리 CLI
bun run src/workspaces/cli.ts create "동아리A" Uowner1234...
bun run src/workspaces/cli.ts list
bun run src/workspaces/cli.ts status {id}
```

- 코드 변경 후 타입 체크 + 테스트 통과 필수
- Docker 이미지: `oven/bun:alpine` 기반

## Collaboration Rules (세션 간 병렬 작업)

### 원칙 1: 전체 영향 작업 병합 우선 (Global-Impact-First Merge)

프로젝트 전체에 걸쳐 영향을 주는 작업은 **병합 우선권**을 가진다.

- **정의**: 기존 코드의 패턴·규격·인프라를 프로젝트 전반에 걸쳐 일괄 변경하는 작업. 2개 이상의 모듈(Commit Convention의 scope 기준)에 걸쳐 기존 코드를 수정하는 경우 해당
- **대상 예시**: 로그 시스템 도입, 전체 주석 규격 변경, 아키텍처 리팩토링, 신기술 전면 적용 등
- **병합 순서**: 전체 영향 작업의 PR이 main에 병합될 때까지 다른 작업의 PR 병합 보류
- **개발은 자유**: 독립 작업의 개발 자체는 별도 worktree에서 병렬 진행 가능
- **식별**: 전체 영향 작업 PR에는 PR 생성자가 `global-impact` 라벨 부착. 작업 시작 전 해당 라벨의 열린 PR 존재 여부 확인
- **이유**: 전체 영향 작업은 다수 파일을 수정하므로, 다른 작업이 먼저 병합되면 rebase 충돌이 폭발적 증가. 반대 순서면 독립 작업의 충돌 범위는 관리 가능

### 원칙 2: 작업 격리 (Worktree Isolation)

모든 작업은 **독립적 단위로 구성**하고 **별도 worktree에서 처리**한다.

- **작업 시작 전 충돌 확인**: 열린 PR, 진행 중 기능 작업과의 파일 겹침 검토
- **worktree 필수**: 모든 작업은 feature branch를 별도 worktree에서 체크아웃하여 진행
- **PR 재개 시에도 적용**: 피드백 반영, 충돌 해소 등 기존 PR 작업 재개 시에도 worktree 세션 진입
- **이유**: 메인 작업 디렉터리를 깨끗하게 유지하고 작업 간 간섭 방지

## Branch Strategy

- `main` 브랜치 보호: 직접 커밋/force push 금지 (GitHub Rulesets로 강제)
- 모든 작업은 feature branch에서 수행 → PR 리뷰 후 squash and merge (linear history)
- 브랜치 네이밍: `feature/*`, `fix/*`, `docs/*`, `chore/*`, `test/*`, `refactor/*`
- 병합 완료 후 feature branch 삭제
- 글로벌 `rules/github-vc.md` 기본값 적용

## Commit Convention

- Conventional Commits: `<type>(<scope>): <description>`
- **type**: `feat`, `fix`, `docs`, `chore`, `test`, `refactor`, `style`, `perf`, `ci`
- **scope**: `agent`, `channel`, `skill`, `jobs`, `routes`, `config`, `workspaces`, `approvals`, `docker` 등 계층/모듈 단위
- **언어**: 한국어(기본) > 영어 — `<description>`과 body 모두 해당
- 1 태스크 = 1 커밋 (독립 cherry-pick 가능)
- `git add -A`/`.` 금지 — 파일명 명시로 스테이징

## Pull Request Rules

- PR 생성 필수 — main에 직접 push 불가
- 최소 1명의 리뷰 승인 후 병합
- 병합 전 `bun run typecheck` + `bun test` 통과 필수

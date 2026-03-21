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
| GWS Skill | Google APIs (`googleapis` + `google-auth-library`) — Native Tool (in-process) |
| LINE Skill | `@line/line-bot-mcp-server` — MCP Tool (메시지 발신) |
| LINE Channel | SDK-free (Web Crypto + native fetch) — Webhook 수신 전용 |
| MCP Transport | Connection Pool (N개 stdio 프로세스, least-inflight 디스패치) |
| Logging | LogTape (`@logtape/logtape`) — 0 의존성, 구조화 로깅, 환경변수 레벨 제어 |
| Scheduler | Croner (Bun 공식 지원, 0 의존성) |
| Deploy | Docker Compose (`oven/bun:alpine`) on MacBook Pro M4 Pro |
| Tunnel | Cloudflare Tunnel — LINE Webhook 수신용 |

## Architecture

→ 상세: `rules/architecture.md`

### Functional Core / Imperative Shell

- **Functional Core** (`domain/`): 순수 함수, I/O 없음. 입력 불변, 새 객체 반환
- **Imperative Shell** (Store, Webhook, Agent Loop): I/O 수행. Core를 호출하여 검증/전이를 위임
- Core → Shell 의존 금지. Core는 `types.ts`의 데이터 타입만 참조

### LLM/시스템 경계

- LLM: 판단 (도구 선택, 응답 생성)
- 시스템: 결정론적 처리 (userId 주입, 권한 검사, 라우팅, 형식 변환)

## Safety Rules (위반 금지)

1. **사용자 승인 없이 메일 발송 금지** — `gmail_send`/`gmail_reply`는 write 도구(Owner 승인 필수). 에이전트가 사용자 확인 없이 자동 발송하지 않음
2. **캘린더 추가 시 확인 필수** — 추가 내용을 LINE으로 제시한 후 실행
3. **GWS API 호출은 googleapis 공식 라이브러리 사용** — OAuth2Client + 서비스별 클라이언트
4. **LINE Webhook은 반드시 signature 검증** — Web Crypto API로 HMAC-SHA256 검증. 미검증 요청 처리 금지
5. **에이전트 루프 무한 반복 방지** — 도구 호출 최대 횟수 제한 설정 필수
6. **사용자 권한 확인 필수** — 활성(`active`) 사용자만 에이전트 루프 실행. 미초대/비활성 사용자 요청은 무시 또는 안내 메시지
7. **초대/승인 명령은 결정론적 처리** — 패턴 매칭. Claude 판단에 의존하지 않음
8. **GWS 데이터는 워크스페이스 단위 격리** — 워크스페이스별 OAuth 토큰 (암호화 저장). Member의 write는 Owner 승인 필요
9. **LINE push user_id는 프로그래밍적 보장** — 시스템 프롬프트 지시 + `push_` 도구 실행 전 코드에서 강제 주입. Claude 출력에 의존하지 않음

## AI Model 사용 규칙

| 용도 | 모델 | 이유 |
|------|------|------|
| Agent loop (기본) | `claude-haiku-4-5-20251001` | 저비용, 고속, tool_use 지원 |
| 복잡한 판단 | `claude-sonnet-4-6` | 필요 시에만 사용 |

- 모델 ID는 위 표의 값을 정확히 사용할 것
- 새 모델 추가 시 이 파일을 먼저 갱신

## Coding Conventions

→ 상세: `rules/coding-conventions.md`

- TypeScript strict mode + ESM. 공통 타입은 `src/types.ts`에 정의
- Functional Core (`domain/`)는 데이터 타입만 import — Store/Shell 모듈 직접 의존 금지
- 주석: 한국어 + TSDoc/JSDoc. export 대상에 `/** */` 필수
- TDD: 테스트 선행 (Red → Green → Refactor). `bun:test` 사용. co-location (`*.test.ts`)
- 환경변수: `.env.example` 참조. `src/config.ts`에서 로딩 + 검증

## Verification Commands

```bash
bun run typecheck    # 타입 체크 (tsc --noEmit)
bun test             # 테스트 (bun 내장 테스트 러너)
bun run dev          # 개발 서버 (HMR)
docker compose up -d # Docker 프로덕션 배포
```

- 코드 변경 후 `bun run typecheck` + `bun test` 통과 필수

## Collaboration Rules

### 원칙 1: 전체 영향 작업 병합 우선 (Global-Impact-First Merge)

- 프로젝트 전반에 걸친 일괄 변경은 병합 우선권. `global-impact` 라벨로 식별
- 해당 PR 병합 전까지 다른 PR 병합 보류. 개발 자체는 별도 worktree에서 병렬 진행 가능

### 원칙 2: 작업 격리 (Worktree Isolation)

- 모든 작업은 별도 worktree에서 처리. PR 재개 시에도 적용
- 작업 시작 전 열린 PR과의 파일 겹침 검토

### 원칙 3: 지시파일 정합성 유지 (Instructions Freshness)

- 작업 수행 시 관련 지시파일(`CLAUDE.md`, `rules/`)의 내용이 현재 코드와 일치하는지 확인
- 코드 변경으로 지시파일 내용이 stale해지면 해당 작업 내에서 갱신
- 확인 시점: 작업 시작 시 컨텍스트 수집 단계, 코드 변경 완료 후

## Branch Strategy

- `main` 보호: 직접 커밋/force push 금지 (GitHub Rulesets)
- feature branch → PR 리뷰 → squash and merge (linear history)
- 네이밍: `feature/*`, `fix/*`, `docs/*`, `chore/*`, `test/*`, `refactor/*`
- 글로벌 `rules/github-vc.md` 기본값 적용

## Commit Convention

- Conventional Commits: `<type>(<scope>): <description>`
- **type**: `feat`, `fix`, `docs`, `chore`, `test`, `refactor`, `style`, `perf`, `ci`
- **scope**: `agent`, `channel`, `skill`, `jobs`, `routes`, `config`, `workspaces`, `approvals`, `docker` 등
- **언어**: 한국어(기본) > 영어
- 1 태스크 = 1 커밋. `git add -A`/`.` 금지

## Pull Request Rules

- PR 생성 필수 — main에 직접 push 불가
- 최소 1명의 리뷰 승인 후 병합
- 병합 전 `bun run typecheck` + `bun test` 통과 필수

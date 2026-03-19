# Coding Conventions

## TypeScript

- strict mode + ESM (`"type": "module"`)
- 공통 타입은 `src/types.ts`에 정의 — 도메인 데이터 타입과 Shell 간 공유 인터페이스
- Functional Core (`domain/`)는 데이터 타입만 import — Store/Shell 모듈 직접 의존 금지

## 주석 규격 (Comment Convention)

- **언어**: 한국어(기본) > 영어. 코드 식별자 및 기술 용어는 영어 유지
- **형식**: TSDoc/JSDoc 표준 (`/** */` 블록)
  - export되는 함수, 클래스, 인터페이스, 타입에 `/** */` 문서화 주석 필수
  - `@param`, `@returns`, `@throws` 등 TSDoc 태그 사용
  - 내부 구현 설명은 `//` 인라인 주석 허용
- **기존 주석 포함**: 기존 영어 주석도 한국어 + TSDoc 형식으로 갱신 대상

## LINE Webhook 수신 (Channel Layer, SDK-free)

- signature 검증: `crypto.subtle.verify()` (Web Crypto API, timing-safe)
- raw body 보존: signature 검증 전 body 파싱/변환 금지

## LINE 메시지 발신 (Skill Layer, MCP Pool)

- 에이전트가 LINE MCP Server 도구로 자율 발신
- MCP Pool 경유 (least-inflight 디스패치)
- 에이전트 시스템 프롬프트에 메시지 포맷 규칙 포함:
  - 2000자 이내 (간결하게)
  - 줄바꿈으로 가독성 확보
- 에이전트 응답 언어 정책:
  - 사용자가 특정 언어로 작성하면 동일 언어로 응답
  - 자동 알림(cron/follow/invite) 및 언어 불확실 시 영어 기본값
  - 프롬프트(시스템/cron/webhook)는 영어로 작성 (Claude 인식 최적화)

## GWS CLI 호출

- 모든 명령에 `--format json` 플래그 사용
- 타임아웃 30초 설정
- `GWS_CONFIG_DIR` 환경변수로 워크스페이스별 인증 경로 전달
- 워크스페이스별 `gws auth login --config-dir {path}`으로 사전 인증

## 스킬 추가 규칙

- Native Tool: `skills/<name>/tools.ts` (도구 정의) + `executor.ts` (실행 구현) + `access.ts` (접근 제어)
- MCP Tool: `agent/mcp.ts`에 MCP Server 연결 추가 (도구 정의는 MCP Server가 제공)
- Agent Core 수정 불필요

## Testing (TDD)

- **방법론**: TDD 준수 — 새 기능/수정 시 테스트 선행 (Red → Green → Refactor)
- **러너**: `bun:test` (Bun 내장, 추가 의존성 불필요)
- **파일 배치**: 소스 파일과 동일 디렉터리에 `*.test.ts` (co-location)
- **네이밍**: `describe("모듈명")` > `test("동작 설명")`
- **테스트 분류**:

| 분류 | 대상 | 전략 |
|------|------|------|
| 순수 로직 | domain/*, access, error, event parsing, system prompt | 직접 호출, mock 불필요 |
| Store I/O | JsonFileStore, UserStore, WorkspaceStore, PendingActionStore | 임시 파일 (`$TMPDIR`), 실제 I/O |
| 비즈니스 로직 | interceptor, notify, executor caching | Store/Registry mock |
| HTTP | health route | `app.request()` (Hono 내장) |

- **검증 기준**: 코드 변경 후 `bun run typecheck` + `bun test` 모두 통과 필수

## 워크스페이스 프로비저닝 (시스템 관리자)

1. CLI: `bun run src/workspaces/cli.ts create "이름" Uowner...`
2. 또는 LINE: `create-workspace 이름 Uowner...`
3. GWS 인증: `docker exec -it assistant gws auth login --config-dir data/workspaces/{id}/gws-config/`

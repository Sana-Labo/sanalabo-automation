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

## 도구 정의 (ToolDefinition)

- **Zod 4 단일 출처**: 모든 도구의 입력 스키마는 Zod로 정의 (`agent/tool-definition.ts`)
  - Claude API용 JSON Schema: `toAnthropicTool()`로 변환 (Zod 4 내장 `z.toJSONSchema`)
  - 런타임 검증: `inputSchema.safeParse()` — non-strict 도구만 (strict 도구는 constrained decoding에 의존)
  - TypeScript 타입 추론: `z.infer<typeof schema>`
- **카테고리별 확장**: `GwsToolDefinition<T>`, `LineToolDefinition<T>`, `SystemToolDefinition<T>`, `InfraToolDefinition<T>`
- **자기 완결적 구조**: 각 도구 = 스키마 + 실행의 독립 단위 (업계 7개 프레임워크 표준 패턴)

## GWS API 호출 (googleapis)

- `google-auth-library` + `@googleapis/*` 공식 라이브러리 사용
- 워크스페이스별 OAuth2Client 인스턴스 (TokenStore에서 refresh_token 로드)
- 도구 정의: `skills/gws/{gmail,calendar,drive}-tools.ts` (서비스별 분리, `GwsToolDefinition` 자기 완결적)
- 도메인 헬퍼: `skills/gws/api-helpers.ts` (extractBody, buildRawEmail, jsonResult 등)
- executor 팩토리: `skills/gws/executor.ts` (OAuth + `createExecutor` DI → executor Map)
- 토큰 회전(rotation): `tokens` 이벤트 감지 → TokenStore에 자동 저장

## 스킬 추가 규칙

- Native Tool: `skills/<name>/*-tools.ts` (ToolDefinition 자기 완결적) + `executor.ts` (팩토리) + `access.ts` (접근 제어)
- MCP Tool: `agent/mcp.ts`에 MCP Server 연결 추가 + `agent/line-tool-adapter.ts`에 LineToolDefinition 정의
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

## 워크스페이스 관리 (System Tool)

- **일반 사용자**: 에이전트와 대화 → `create_workspace` (사용자당 1개 제한), `list_workspaces`, `get_workspace_info` (소유 WS만)
- **시스템 관리자**: 동일 System Tool 사용. `create_workspace`에서 `owner_user_id`로 대상 지정 가능. `list_workspaces`/`get_workspace_info`는 전체 조회
- **GWS 인증**: `authenticate_gws` System Tool로 OAuth 링크 발송 → 브라우저 인증 → 자동 토큰 저장

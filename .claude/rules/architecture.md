# Architecture

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

## 아키텍처 패턴: Functional Core / Imperative Shell

Gary Bernhardt의 "Boundaries"(2012) 기반.

- **Functional Core** (`domain/`): 순수 함수, I/O 없음. 입력 불변, 새 객체 반환
- **Imperative Shell** (Store, Webhook, Agent Loop): I/O 수행. Core를 호출하여 검증/전이를 위임
- **값으로 통신**: Core는 Shell의 존재를 모름. 데이터를 받고 데이터를 반환

### 의존 규칙

- Core → Shell 의존 금지 (Store, Shell 모듈 import 불가)
- Core는 `types.ts`의 데이터 타입만 참조
- Shell → Core 호출 허용

### LLM/시스템 경계

- LLM: 판단 (도구 선택, 응답 생성)
- 시스템: 결정론적 처리 (userId 주입, 권한 검사, 라우팅, 형식 변환)

## 역할 체계

| 역할 | 범위 | GWS 접근 | 관리 권한 |
|------|------|----------|----------|
| **System Admin** | 전체 시스템 | 워크스페이스 지정 시 Owner와 동일 | 워크스페이스 프로비저닝 (CLI), 모니터링 |
| **Owner** | 1 워크스페이스 | 읽기 + 쓰기 (본인 Google 계정) | LINE에서 멤버 초대/제거 |
| **Member** | 1+ 워크스페이스 | 읽기 O, 쓰기 → Owner 승인 필요 | — |

## 핵심 개념

| 용어 | 정의 | 예시 |
|------|------|------|
| **Workspace** | GWS 계정 + 멤버 그룹의 단위 | 동아리 A의 Google 계정 |
| **Skill** | 능력의 묶음 (도메인 단위) | Google Workspace 조작, LINE 메시징 |
| **Tool** | 스킬 안의 개별 조작 (Claude가 tool_use로 호출하는 단위) | `gmail_list`, `push_text_message` |
| **Native Tool** | 에이전트가 직접 실행하는 도구 | GWS CLI → `Bun.spawn` |
| **MCP Tool** | MCP Server를 경유하여 실행하는 도구 | LINE MCP Server → `push_text_message` |

Claude는 Native Tool과 MCP Tool의 차이를 모른다. 둘 다 동일한 tool_use로 호출.

## 스킬 구성

| Skill | 구현 방식 | Tools | 이유 |
|-------|----------|-------|------|
| Google Workspace | Native Tool (`Bun.spawn` → GWS CLI) | `gmail_*`, `calendar_*`, `drive_*` | 워크스페이스별 configDir로 격리 |
| LINE 메시징 | MCP Tool (`@line/line-bot-mcp-server`) | `push_text_message`, `push_flex_message` 등 | MCP Pool 경유 |

## LINE 통신의 역할 분리

| 역할 | 위치 | 구현 |
|------|------|------|
| **수신** (Webhook) | Channel Layer | Hono + Web Crypto signature 검증 |
| **발신** (메시지 전송) | Skill Layer (MCP Pool) | 에이전트가 LINE MCP Server 도구로 자율 발신 |

## Agent Core 동작 방식

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

## Write Approval Flow (Member → Owner)

1. Member가 write 도구 호출 → `interceptWrite()` 가로채기
2. `PendingAction` 생성 → Owner에게 Flex Message (Approve/Reject 버튼)
3. Owner가 postback 또는 `approve {id}` 텍스트로 승인
4. 원래 도구 실행 → 양측에 결과 통지

## MCP Connection Pool

- N개(기본 3) MCP 클라이언트 프로세스 풀
- **Least-inflight 디스패치**: 가장 여유 있는 멤버에 라우팅
- **멤버별 격리 재연결**: 한 멤버 장애가 다른 멤버 차단하지 않음
- **헬스 체크**: 30초 간격 ping, 3회 연속 실패 → unhealthy → 백그라운드 재연결
- Health 엔드포인트에서 풀 상태 노출

## Cron 잡 (자동 통지)

| Schedule | Job | 내용 |
|----------|-----|------|
| `0 8 * * 1-5` | morningBriefing | 미독 메일 요약 + 오늘 일정 |
| `*/30 8-22 * * *` | urgentMailCheck | 긴급 메일 LINE 통지 |
| `0 21 * * 1-5` | eveningSummary | 오늘 활동 요약 + 내일 일정 |
| `0 * * * *` | pendingActionExpiry | 24시간 경과 PendingAction 만료 |

Cron 잡은 워크스페이스별 → 멤버별로 순회. 각 멤버의 ToolContext(workspaceId, role)로 Agent Core 호출.

## Webhook 동시성

- **사용자별 큐**: 같은 사용자 내 순차 처리 (대화 순서 보장), 다른 사용자 간 병렬 실행
- JS 단일 스레드 이벤트 루프에서 `Map` 접근 경쟁 없음
- 큐 드레인 후 자동 정리 (메모리 누수 방지)

## 사용자 관리 + 워크스페이스

**사용자 상태** (`UserStatus`):

| 상태 | 설명 | 전이 |
|------|------|------|
| `active` | 서비스 이용 중 | unfollow 이벤트 → `inactive` |
| `inactive` | 탈퇴 (블록) | — |

**초대 플로우**:
1. Owner가 에이전트에게 초대 요청 → Claude가 `invite_member` System Tool 호출
2. 멤버 추가 → Claude가 push_text_message로 초대 대상에게 알림 발송
3. 초대된 사용자가 `enter_workspace`로 워크스페이스 진입

**워크스페이스 진입 (Out/On Stage)**:
- **Out stage**: `lastWorkspaceId` 미설정 또는 미매칭 → 워크스페이스 목록 + 진입 안내
- **On stage**: `lastWorkspaceId` 매칭 → 워크스페이스 내 작업 수행 가능
- 진입: `enter_workspace` System Tool 또는 `create_workspace` 후 자동 진입
- 단일 소속이라도 자동 진입 없음 — 명시적 진입 모델

**시스템 관리자**: `SYSTEM_ADMIN_IDS` 환경변수로 지정. 시작 시 자동 `active` 등록.

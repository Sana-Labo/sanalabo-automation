# Agent Orchestration — 업계 비교 참조 문서

> 조사일: 2026-03-26 | 프로젝트: sanalabo-automation
>
> 소스: Claude Code npm 번들 분석, Codex CLI GitHub 소스, SK GitHub 소스 + MS Learn, 각 프로바이더 공식 문서

---

## 1. 오케스트레이션 3계층 모델

에이전트 시스템의 오케스트레이션 기능을 3계층으로 분류한다.
이 분류는 정식 출처가 있는 업계 표준은 아니며, 여러 제품/프레임워크를 분석하여 도출한 분석 프레임워크이다.

```
[Layer 3] Multi-agent 조율
    "어떤 에이전트가 무엇을 할 것인가"
    → SK, LangGraph, CrewAI, AutoGen

[Layer 2] Single-agent 생존
    "한 에이전트가 API 한계 속에서 어떻게 동작하는가"
    → Claude Code, Codex CLI (제품 수준 통합)

[Layer 1] Core Loop
    "도구 선택 → 실행 → 응답"
    → 모든 에이전트의 기본
```

### 계층별 관심사

| Layer | 관심사 | 핵심 질문 |
|-------|--------|----------|
| **3** | 에이전트 간 라우팅, 핸드오프, 합의 | "이 작업을 누가 처리할 것인가?" |
| **2** | Context window 관리, 재시도, 모델 폴백 | "API 한계 안에서 어떻게 생존할 것인가?" |
| **1** | tool_use 루프, 도구 디스패치 | "어떤 도구를 호출하고 결과를 어떻게 처리할 것인가?" |

### 제품 vs 프레임워크

| | 제품 (Claude Code, Codex CLI) | 프레임워크 (SK, LangGraph) |
|---|---|---|
| Layer 2 | 내장 (3단계 compact, 재시도, 폴백) | 제한적~외부 위임 |
| Layer 3 | 해당 없음 (단일 에이전트) | 핵심 기능 |
| LLM 프로바이더 | 단일 (자사 API 최적화) | 다수 (프로바이더 독립) |

프레임워크가 Layer 2를 외부 위임하는 주된 이유는 **프로바이더 다양성** — 각 LLM마다 토큰 카운팅, 에러 코드, compact API가 다르기 때문.
단, 일부 프레임워크는 context 관리를 제공한다:
- **LangGraph**: `trim_messages`(`langchain-core` 패키지, 토큰 기반 절단)를 공식 권장. `summarize_messages`는 별도 `langmem` 패키지
- **CrewAI**: `respect_context_window=True`(Agent 레벨, 기본값) — 단, 사전 예방이 아닌 `ContextWindowExceededError` 발생 후 LLM 요약 → 재시도하는 **사후 복구** 방식

"외부 위임이 업계 공통"은 과장이지만, 제공되는 context 관리도 제품 수준(Claude Code, Codex CLI)의 3단계 compact에 비하면 제한적이다.

---

## 2. Layer 2 — 업계 비교

### 2.1 Context Window 관리 (Compact)

| 기능 | Claude Code | Codex CLI | SK | LangGraph | CrewAI |
|------|------------|-----------|-----|-----------|--------|
| **Micro-compact** | 매 턴 도구 결과 압축 ^npm | 1.2x budget 절단 (10KB 기본) | - | - | - |
| **Auto-compact** | 서버 API (~95% 트리거) | 토큰 임계값 + LLM 요약 | 메시지 수 기반 (IChatHistoryReducer) | 토큰 기반 절단 (`trim_messages`) ^lc-core | 에러 후 LLM 요약 → 재시도 ^reactive |
| **Reactive-compact** | 1회 한정 + circuit breaker 3회 ^npm | ContextWindowExceeded → 재시도 | - | - | `respect_context_window` ^reactive |

> ^npm: npm 번들 분석에서만 확인, 공식 문서 미기재
> ^lc-core: LangGraph 내장이 아닌 `langchain-core` 패키지 유틸리티
> ^reactive: 사전 예방이 아닌 `ContextWindowExceededError` 후 사후 복구

#### Claude Code (v2.1.83)

> 소스: 공식 문서 확인 항목은 ✅, npm 번들 역분석에서만 확인된 항목은 ⚠️ 로 표기

- ⚠️ 매 턴: `microcompact` → `autocompact` 순서 실행
- ⚠️ 서버 사이드 `compact-2026-01-12` 베타 API 사용
- ✅ `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`: 트리거 비율 (1-100%, 기본 ~95%) — 공식 env-vars 페이지 기재
- ✅ Circuit breaker: 연속 3회 실패 시 중단 — changelog v2.1.76
- ⚠️ Reactive compact: 프롬프트 초과/미디어 에러 시 즉시 시도 (1회 한정)

#### Codex CLI (Rust 코어)
- **Micro**: `truncate_function_output_payload()` — 1.2x serialization budget, `TruncationPolicy`로 바이트/토큰 두 모드
- **Auto**: `run_inline_auto_compact_task()` — 토큰 임계값 도달 시 LLM 요약 + 최근 20,000 토큰 유지
  - Local compact: 히스토리에서 user messages 추출 → 요약 생성 → 역시간순 최근 메시지 선택 + 요약 추가
  - Remote compact: OpenAI 전용, `model_client.compact_conversation_history()` 서버 호출
  - `InitialContextInjection` 전략: `BeforeLastUserMessage` (턴 중간) / `DoNotInject` (턴 전/수동)
- **Reactive**: `CodexErr::ContextWindowExceeded` → auto-compact 실행 → 턴 재시도. compact 내부에서도 지수 백오프 + 히스토리 트리밍

#### Semantic Kernel
- `IChatHistoryReducer` 인터페이스 + 2개 내장 구현
- `ChatHistoryTruncationReducer`: 메시지 수 기반 절단, function-call/result 쌍 분리 방지
- `ChatHistorySummarizationReducer`: LLM으로 오래된 메시지 요약, `__summary__` 메타데이터 태그
- **토큰 기반이 아닌 메시지 수 기반**이 핵심 제약

### 2.2 max_tokens 재시도

| | Claude Code | Codex CLI | SK |
|---|---|---|---|
| 재시도 횟수 | 3회 ⚠️ | 지수 백오프 | 미제공 |
| 메커니즘 | resume 프롬프트 주입 ⚠️ | 히스토리 트리밍 시 카운터 리셋 | 외부 위임 (Polly 등) |

> ⚠️ npm 번들 역분석에서만 확인. 공식 문서에 max_tokens 재시도 관련 기재 없음

Claude Code resume 프롬프트 (npm 번들에서 추출): `"Output token limit hit. Resume directly -- no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces."`

### 2.3 모델 폴백

**업계 전체에서 미성숙한 영역.** 범용 모델 폴백을 기본 제공하는 프레임워크/제품은 없음.

| | Claude Code | Codex CLI | SK | litellm |
|---|---|---|---|---|
| Overload 폴백 | `--fallback-model` (`--print` 전용, HTTP 529) | - | - | ✅ 프로바이더 간 전환 |
| 구독 기반 | Opus → Sonnet (사용량 한도) | - | - | - |
| Streaming 폴백 | streaming → non-streaming (64K 캡, 300초) | - | - | - |
| Transport 폴백 | - | WS → HTTP (세션 잔여 기간) | - | - |
| 범용 모델 폴백 | ❌ | ❌ | ❌ | ✅ |

litellm이 사실상 유일한 범용 모델 폴백 솔루션이나, Python 전용이며 Layer 2 전체를 커버하지는 않음 (compact 미제공).

### 2.4 턴 제한

| | Claude Code | Codex CLI | SK |
|---|---|---|---|
| 턴 제한 | max_turns 설정 | 미제공 (시간 기반: `job_max_runtime_seconds`) | 3계층 독립 |

SK 3계층:
- 함수 호출: `maximum_auto_invoke_attempts` = 5
- GroupChat (1세대, deprecated): `MaximumIterations` = 99
- Orchestration (2세대): `MaximumInvocationCount` = int.MaxValue

---

## 3. Layer 3 — SK Multi-agent 오케스트레이션

### 3.1 5개 패턴

SK 2세대 Agent Orchestration Framework (experimental, RC 발표 2026-02).
Actor 모델 기반, `InProcessRuntime`이 메시지 디스패치.

#### (1) Sequential — 파이프라인

```
Agent A → Agent B → Agent C → 결과
```

각 에이전트의 출력이 다음 에이전트의 입력. 초안 작성 → 검토 → 번역 등.

#### (2) Concurrent — 병렬 실행

```
         +-> Agent A -+
입력 ----+-> Agent B -+-> 결과 수집
         +-> Agent C -+
```

모든 에이전트에 동시 브로드캐스트, 독립 수집. 동일 질문을 여러 전문가에게 동시 질의.

#### (3) Handoff — 동적 제어 전달

```
Agent A --transfer_to_B--> Agent B --transfer_to_C--> Agent C
                                                       |
                                              end_task_with_summary
```

에이전트가 스스로 판단하여 다른 에이전트에게 작업 인계.

구현 메커니즘:
- `HandoffAgentActor`(Python) / `HandoffActor`(.NET)가 에이전트의 Kernel을 클론
- `transfer_to_{name}` 함수를 `KernelPlugin`으로 동적 주입
- `HandoffInvocationFilter`가 핸드오프 함수 호출 시 대화 중단

#### (4) GroupChat — 관리자 주도 토론

```
Manager --SelectNextAgent--> Agent A --응답--> Manager
   |                                              |
   +------ShouldTerminate?--No--> Agent B -----> Manager
                            Yes--> FilterResults -> 결과
```

`GroupChatManager` 추상 클래스의 4개 메서드:
- `SelectNextAgent()` — abstract, 다음 발언자 선택
- `ShouldTerminate()` — virtual (기본 구현: `MaximumInvocationCount` 비교), 종료 판단
- `FilterResults()` — abstract, 결과 필터링
- `ShouldRequestUserInput()` — abstract, 사용자 입력 필요 여부

내장 구현: `RoundRobinGroupChatManager`

#### (5) Magentic — 계획 + 위임 + 추적

```
Manager --계획 수립--> [Task 1: Agent A]
                       [Task 2: Agent B]
                       [Task 3: Agent C]
   |
   +--라운드별 진행 추적
   +--다음 에이전트 선택
   +--최종 답변 합성
```

MagenticOne 논문 기반. `StandardMagenticManager`가 계획 → 위임 → 추적 → 합성.

### 3.2 Actor 모델 인프라

```
[InProcessRuntime]
    |
    +-- AgentActor (Agent A)
    +-- AgentActor (Agent B)
    +-- HandoffAgentActor / GroupChatManagerActor
    +-- OrchestrationActor (결과 수집)
```

- 각 에이전트가 Actor로 격리 — 상태 공유 없이 메시지로만 통신
- SK가 동일 Actor 모델 인터페이스를 **자체 구현** (AutoGen 패키지를 직접 import하지 않음)
- Microsoft Agent Framework 우산 아래에서 AutoGen과 통합 진행 중
- 장점: 결합도 제거, 패턴 교체 용이, 분산 확장 가능

### 3.3 IChatHistoryReducer — Layer 2-3 경계

| 구현 | 방식 | 특징 |
|------|------|------|
| `ChatHistoryTruncationReducer` | 오래된 메시지 제거 | 메시지 수 기반, function-call/result 쌍 분리 방지 (`LocateSafeReductionIndex`) |
| `ChatHistorySummarizationReducer` | LLM으로 요약 | `__summary__` 태그, 누적/시계열 선택 (`UseSingleSummary`), 커스텀 프롬프트 |

에이전트별 다른 Reducer 할당 가능 → multi-agent 시 각 에이전트의 context 전략을 독립 관리.

---

## 4. LLM 프로바이더별 API 비교

### 4.1 서버 사이드 Compact API

| | Anthropic | OpenAI | Google |
|---|---|---|---|
| **서버 사이드 compact** | 베타 (`compact-2026-01-12`) | GA (inline + standalone) | 미제공 |
| **결과 형식** | 투명한 텍스트 요약 (검사/수정 가능) | 불투명 (opaque, 모델만 해석) | - |
| **커스터마이징** | `instructions` (요약 프롬프트 대체), `pause_after_compaction` | 불가 | - |
| **엔드포인트** | Messages API 파라미터 (`context_management`) | `POST /responses/compact` (standalone) + inline | - |
| **비용 추적** | `usage.iterations` 배열로 compaction/message 분리 | 미공개 | - |
| **캐싱 통합** | Prompt Caching 적용 가능 | 미공개 | - |
| **대안 전략** | - | - | 대용량 Context Window (1M~2M) + Context Caching |

#### Anthropic Compaction API 상세

```json
{
  "model": "claude-sonnet-4-6",
  "messages": [...],
  "context_management": {
    "edits": [{
      "type": "compact_20260112",
      "trigger": { "type": "input_tokens", "value": 150000 },
      "pause_after_compaction": false,
      "instructions": null
    }]
  }
}
```

- 베타 헤더: `anthropic-beta: compact-2026-01-12`
- 트리거 최소값: 50,000 토큰
- 동작: 입력 토큰 > trigger → 서버에서 대화 요약 → `compaction` 블록 반환 → 후속 요청에서 이전 내용 자동 무시

**지원 모델**: Claude Opus 4.6, Claude Sonnet 4.6 (Haiku 4.5 **미지원**)

#### Anthropic Context Editing (관련 API)

Compaction과 동일한 `context_management.edits` 구조를 공유:

| 전략 | 베타 헤더 | 역할 | Haiku 지원 |
|------|-----------|------|-----------|
| `compact_20260112` | `compact-2026-01-12` | 서버 사이드 요약 | ❌ |
| `clear_tool_uses_20250919` | `context-management-2025-06-27` | 도구 결과 선택적 제거 | ✅ |
| `clear_thinking_20251015` | `context-management-2025-06-27` | thinking 블록 관리 | ✅ |

### 4.2 Rate Limit 구조

| | Anthropic | OpenAI | Google |
|---|---|---|---|
| **토큰 limit 단위** | ITPM / OTPM 분리 | TPM 합산 (input + output) | TPM (input만) |
| **Cache 토큰** | `cache_read` 미카운트 → 실효 처리량 증가 | 해당 없음 | 미공개 |
| **max_tokens 영향** | OTPM에 영향 없음 | TPM에 영향 (설정값 기준) | 미공개 |
| **실패 요청** | 미명시 | 카운트됨 | 카운트됨 |
| **에러 코드** | 429 (rate limit) + 529 (overload 별도) | 429 | 429 |
| **retry-after 헤더** | 있음 (초 단위) | 있음 (시간 형식) | 미제공 |
| **알고리즘** | Token Bucket (연속 보충) | 미공개 | 미공개 |
| **Tier 수** | 4 + Monthly Invoicing | Free + 5 Tier | Free + 3 Tier |

#### Anthropic Tier 4 기준 수치 (최고 셀프서브)

| 모델 | RPM | ITPM | OTPM |
|------|-----|------|------|
| Claude Opus 4.x (합산) | 4,000 | 2,000,000 | 400,000 |
| Claude Sonnet 4.x (합산) | 4,000 | 2,000,000 | 400,000 |
| Claude Haiku 4.5 | 4,000 | 4,000,000 | 800,000 |

#### 에러 코드별 대응 전략

```
429 rate_limit_error
  → retry-after 헤더 확인 → 해당 시간만큼 대기 후 재시도
  → anthropic-ratelimit-*-remaining 헤더로 잔여량 모니터링

529 overloaded_error
  → 서버 과부하. retry 가능하나 장시간 지속 가능
  → 모델 폴백 트리거 조건
```

---

## 5. 종합 비교표

| 기능 | Claude Code | Codex CLI | SK | LangGraph | CrewAI | litellm |
|------|------------|-----------|-----|-----------|--------|---------|
| Micro-compact | 매 턴 ⚠️ | 1.2x budget | - | - | - | - |
| Auto-compact | 서버 API (~95%) | 토큰 + LLM 요약 | 메시지 수 기반 | 토큰 절단 ^lc | - | - |
| Reactive-compact | 1회 + breaker ⚠️ | CWE → 재시도 | - | - | CWE → 요약 → 재시도 | - |
| max_tokens 재시도 | 3회 + resume ⚠️ | 지수 백오프 | 외부 위임 | - | - | - |
| 모델 폴백 | 제한적 (4종) | transport만 | 외부 위임 | - | - | 프로바이더 간 |
| max_turns | 설정 가능 | 시간 기반 | 3계층 독립 | - | - | - |
| Multi-agent | - | - | 5패턴 | 그래프 | Task+Crew | - |

> ⚠️ npm 번들 역분석에서만 확인, 공식 문서 미기재
> ^lc: `langchain-core` 패키지 유틸리티 (`trim_messages`). LangGraph 내장 아님
> CWE: ContextWindowExceededError

---

## 6. 출처

### 소스코드 분석
- `@anthropic-ai/claude-code` v2.1.83 npm 번들 (키워드 검색 + 텔레메트리 이벤트 추적)
- `openai/codex` GitHub — Rust 코어 (`codex-rs/core/`)
- `microsoft/semantic-kernel` GitHub — Python (`python/semantic_kernel/agents/`) + .NET (`dotnet/src/Agents/`)

### 공식 문서
- [Anthropic Compaction API](https://platform.claude.com/docs/en/build-with-claude/compaction)
- [Anthropic Rate Limits](https://platform.claude.com/docs/en/api/rate-limits)
- [Claude Code Model Configuration](https://code.claude.com/docs/en/model-config)
- [Claude Code Environment Variables](https://code.claude.com/docs/en/env-vars)
- [Claude Code Changelog](https://code.claude.com/docs/en/changelog)
- [OpenAI Rate Limits](https://developers.openai.com/docs/guides/rate-limits)
- [OpenAI Compaction Guide](https://developers.openai.com/api/docs/guides/compaction)
- [Google Gemini Rate Limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- [SK Agent Orchestration](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/)
- [SK Agent Architecture](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-architecture)
- [SK Context Management (Blog)](https://devblogs.microsoft.com/semantic-kernel/semantic-kernel-python-context-management/)

### GitHub Issues
- [Claude Code #8413](https://github.com/anthropics/claude-code/issues/8413) — Fallback model only triggers on overload (NOT_PLANNED)
- [Claude Code #3434](https://github.com/anthropics/claude-code/issues/3434) — Silent Opus-to-Sonnet fallback
- [Claude Code #23920](https://github.com/anthropics/claude-code/issues/23920) — Auto-upgrade to larger context window (NOT_PLANNED)
- [Claude Code #37077](https://github.com/anthropics/claude-code/issues/37077) — Connection-level errors never retried (OPEN)
- [SK Discussion #6105](https://github.com/microsoft/semantic-kernel/discussions/6105) — Retry using different model
- [SK Issue #4744](https://github.com/microsoft/semantic-kernel/issues/4744) — TooManyRequests retry
- [CrewAI Issue #2659](https://github.com/crewAIInc/crewAI/issues/2659) — respect_context_window edge case (요약 후 재초과)

---

## 7. 정보 신뢰도 범례

이 문서는 여러 소스에서 수집한 정보를 포함하며, 소스별 신뢰도가 다르다.

| 표기 | 의미 | 신뢰도 |
|------|------|--------|
| (표기 없음) | 공식 문서 또는 소스코드에서 직접 확인 | 높음 |
| ✅ | 공식 문서에서 명시적으로 확인 | 높음 |
| ⚠️ / ^npm | npm 번들 역분석에서만 확인, 공식 문서 미기재 | 중간 — 난독화된 코드에서 추출. 기능 존재는 확실하나 정확한 동작은 불확실할 수 있음 |
| ^lc-core | `langchain-core` 패키지 소속 (LangGraph 내장 아님) | 높음 — 소스코드 확인 |
| ^reactive | 사전 예방이 아닌 에러 후 사후 복구 방식 | 높음 — 소스코드 확인 |

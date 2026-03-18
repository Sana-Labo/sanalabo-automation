import {
  configure,
  getConsoleSink,
  getLogger,
  getTextFormatter,
  isLogLevel,
  type LogLevel,
  type LogRecord,
  type Sink,
} from "@logtape/logtape";
import type { Logger } from "@logtape/logtape";

const ROOT_CATEGORY = "sanalabo-automation";
const baseFormatter = getTextFormatter();

/**
 * 기본 텍스트 포매터 출력에 구조화 속성을 `key=value` 형태로 추가한다.
 *
 * `getConsoleSink()`의 기본 포매터는 메시지 템플릿만 렌더링하고
 * `record.properties`를 출력하지 않으므로, 디버깅에 필요한 에러 상세 등이 누락된다.
 */
function formatWithProperties(record: LogRecord): string {
  const base = baseFormatter(record);
  const keys = Object.keys(record.properties);
  if (keys.length === 0) return base;
  const pairs = keys.map((k) => {
    const v = record.properties[k];
    return `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`;
  }).join(" ");
  return `${base} ${pairs}`;
}

/**
 * 모듈별 로거를 생성한다.
 * 카테고리: ["sanalabo-automation", module]
 *
 * @param module - 모듈 식별자 (예: "agent", "mcp-pool", "webhook")
 * @returns LogTape Logger 인스턴스
 */
export function createLogger(module: string): Logger {
  return getLogger([ROOT_CATEGORY, module]);
}

/** 테스트 시 sink을 주입하기 위한 옵션 */
export interface LoggingOptions {
  testSink?: Sink;
}

/**
 * 앱 진입점에서 1회 호출하여 로깅을 초기화한다.
 *
 * 환경변수 우선순위:
 * 1. `LOG_LEVEL` (debug/info/warning/error) — 최우선
 * 2. `DEBUG=1` 또는 `DEBUG=true` — debug 레벨 활성화
 * 3. 미설정 — info (프로덕션 기본값)
 *
 * @param options - 테스트용 sink 주입 옵션
 */
export async function configureLogging(options?: LoggingOptions): Promise<void> {
  const raw = process.env["LOG_LEVEL"];
  const level: LogLevel = raw && isLogLevel(raw) ? raw
    : (process.env["DEBUG"] === "1" || process.env["DEBUG"] === "true")
      ? "debug" : "info";

  const sinks: Record<string, Sink> = options?.testSink
    ? { console: options.testSink }
    : { console: getConsoleSink({ formatter: formatWithProperties }) };

  await configure({
    sinks,
    loggers: [
      { category: ["logtape", "meta"], lowestLevel: "warning", sinks: ["console"] },
      { category: ROOT_CATEGORY, lowestLevel: level, sinks: ["console"] },
    ],
    reset: true,
  });
}

export type { Logger, LogRecord } from "@logtape/logtape";

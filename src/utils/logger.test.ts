import { afterEach, describe, expect, test } from "bun:test";
import { configure, type LogRecord } from "@logtape/logtape";
import { createLogger, configureLogging } from "./logger.js";

async function resetLogging(): Promise<void> {
  await configure({ sinks: {}, loggers: [], reset: true });
}

afterEach(async () => {
  await resetLogging();
  delete process.env["LOG_LEVEL"];
  delete process.env["DEBUG"];
});

describe("createLogger", () => {
  test("카테고리가 [sanalabo-automation, module]로 설정된다", () => {
    const log = createLogger("agent");
    expect(log.category).toEqual(["sanalabo-automation", "agent"]);
  });
});

describe("configureLogging", () => {
  test("기본 레벨은 info — info/warning/error 출력, debug 미출력", async () => {
    const captured: LogRecord[] = [];
    await configureLogging({
      testSink: (record: LogRecord) => captured.push(record),
    });

    const log = createLogger("test");
    log.debug("debug msg");
    log.info("info msg");
    log.warning("warning msg");
    log.error("error msg");

    expect(captured).toHaveLength(3);
    expect(captured.map((r) => r.level)).toEqual(["info", "warning", "error"]);
  });

  test.each(["1", "true"])("DEBUG=%s 설정 시 debug 레벨도 출력된다", async (val) => {
    process.env["DEBUG"] = val;
    const captured: LogRecord[] = [];
    await configureLogging({
      testSink: (record: LogRecord) => captured.push(record),
    });

    const log = createLogger("test");
    log.debug("debug msg");

    expect(captured.length).toBeGreaterThanOrEqual(1);
    expect(captured[0]!.level).toBe("debug");
  });

  test("LOG_LEVEL이 DEBUG보다 우선한다", async () => {
    process.env["LOG_LEVEL"] = "warning";
    process.env["DEBUG"] = "1";
    const captured: LogRecord[] = [];
    await configureLogging({
      testSink: (record: LogRecord) => captured.push(record),
    });

    const log = createLogger("test");
    log.debug("debug msg");
    log.info("info msg");
    log.warning("warning msg");
    log.error("error msg");

    expect(captured).toHaveLength(2);
    expect(captured.map((r) => r.level)).toEqual(["warning", "error"]);
  });

  test("잘못된 LOG_LEVEL 값은 무시하고 기본값 info를 사용한다", async () => {
    process.env["LOG_LEVEL"] = "verbose"; // 유효하지 않은 값
    const captured: LogRecord[] = [];
    await configureLogging({
      testSink: (record: LogRecord) => captured.push(record),
    });

    const log = createLogger("test");
    log.debug("debug msg");
    log.info("info msg");

    expect(captured).toHaveLength(1);
    expect(captured[0]!.level).toBe("info");
  });

  test("구조화 데이터가 LogRecord.properties에 포함된다", async () => {
    const captured: LogRecord[] = [];
    await configureLogging({
      testSink: (record: LogRecord) => captured.push(record),
    });

    const log = createLogger("test");
    log.info("Member connected", { memberId: 42 });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.properties).toEqual({ memberId: 42 });
  });
});

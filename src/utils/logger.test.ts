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
  test("Logger 인스턴스를 반환한다", () => {
    const log = createLogger("test-module");
    expect(log).toBeDefined();
    expect(typeof log.info).toBe("function");
    expect(typeof log.debug).toBe("function");
    expect(typeof log.warning).toBe("function");
    expect(typeof log.error).toBe("function");
  });

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

  test("DEBUG=1 설정 시 debug 레벨도 출력된다", async () => {
    process.env["DEBUG"] = "1";
    const captured: LogRecord[] = [];
    await configureLogging({
      testSink: (record: LogRecord) => captured.push(record),
    });

    const log = createLogger("test");
    log.debug("debug msg");
    log.info("info msg");

    expect(captured).toHaveLength(2);
    expect(captured[0]!.level).toBe("debug");
  });

  test("DEBUG=true 설정 시 debug 레벨도 출력된다", async () => {
    process.env["DEBUG"] = "true";
    const captured: LogRecord[] = [];
    await configureLogging({
      testSink: (record: LogRecord) => captured.push(record),
    });

    const log = createLogger("test");
    log.debug("debug msg");

    expect(captured).toHaveLength(1);
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

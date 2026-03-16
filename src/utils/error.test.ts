import { describe, test, expect } from "bun:test";
import { toErrorMessage } from "./error.js";

describe("toErrorMessage", () => {
  test("Error instance returns .message", () => {
    expect(toErrorMessage(new Error("something broke"))).toBe("something broke");
  });

  test("Error subclass returns .message", () => {
    expect(toErrorMessage(new TypeError("type error"))).toBe("type error");
  });

  test("string returns as-is", () => {
    expect(toErrorMessage("plain string")).toBe("plain string");
  });

  test("empty string returns empty string", () => {
    expect(toErrorMessage("")).toBe("");
  });

  test("number is converted to string", () => {
    expect(toErrorMessage(42)).toBe("42");
    expect(toErrorMessage(0)).toBe("0");
    expect(toErrorMessage(-1)).toBe("-1");
  });

  test("null returns 'null'", () => {
    expect(toErrorMessage(null)).toBe("null");
  });

  test("undefined returns 'undefined'", () => {
    expect(toErrorMessage(undefined)).toBe("undefined");
  });

  test("plain object returns '[object Object]'", () => {
    expect(toErrorMessage({ key: "value" })).toBe("[object Object]");
  });

  test("boolean returns string representation", () => {
    expect(toErrorMessage(true)).toBe("true");
    expect(toErrorMessage(false)).toBe("false");
  });
});

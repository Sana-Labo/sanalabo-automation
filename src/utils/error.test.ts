import { describe, test, expect } from "bun:test";
import { toErrorMessage } from "./error.js";

describe("toErrorMessage", () => {
  test("Error instance returns .message", () => {
    expect(toErrorMessage(new Error("something broke"))).toBe("something broke");
    expect(toErrorMessage(new TypeError("type error"))).toBe("type error");
  });

  test("string returns as-is", () => {
    expect(toErrorMessage("plain string")).toBe("plain string");
    expect(toErrorMessage("")).toBe("");
  });

  test.each([
    [42, "42"],
    [null, "null"],
    [undefined, "undefined"],
    [true, "true"],
    [{ key: "value" }, "[object Object]"],
  ])("non-Error/non-string: %p → %p (String() fallback)", (input, expected) => {
    expect(toErrorMessage(input)).toBe(expected);
  });
});

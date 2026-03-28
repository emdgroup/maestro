import { describe, expect, it } from "vitest";
import { getErrorMessage } from "./error-utils";

describe("getErrorMessage", () => {
  it("returns message from Error instance", () => {
    expect(getErrorMessage(new Error("something broke"))).toBe("something broke");
  });

  it("returns string as-is", () => {
    expect(getErrorMessage("raw string error")).toBe("raw string error");
  });

  it("converts number to string", () => {
    expect(getErrorMessage(404)).toBe("404");
  });

  it("converts null to string", () => {
    expect(getErrorMessage(null)).toBe("null");
  });

  it("converts undefined to string", () => {
    expect(getErrorMessage(undefined)).toBe("undefined");
  });

  it("converts object to string", () => {
    expect(getErrorMessage({ code: 500 })).toBe("[object Object]");
  });

  it("returns empty string for empty Error message", () => {
    expect(getErrorMessage(new Error(""))).toBe("");
  });
});

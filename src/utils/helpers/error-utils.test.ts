import { describe, expect, it } from "vitest";
import { getErrorMessage, isProjectLockedError } from "./error-utils";

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

// The Rust side builds this message in project/lock.rs (PROJECT_LOCKED_PREFIX). These cases
// pin the half of that contract that lives in TypeScript: a reworded prefix on either side
// would otherwise silently downgrade the "already open" toast to a generic failure.
describe("isProjectLockedError", () => {
  it("recognises the error string Tauri rejects with", () => {
    expect(isProjectLockedError("PROJECT_LOCKED:42")).toBe(true);
  });

  it("recognises it when wrapped in an Error", () => {
    expect(isProjectLockedError(new Error("PROJECT_LOCKED:7"))).toBe(true);
  });

  it("recognises it when the backend prefixes further context", () => {
    expect(isProjectLockedError("Failed to open project: PROJECT_LOCKED:3")).toBe(true);
  });

  it("does not match an unrelated failure", () => {
    expect(isProjectLockedError("Failed to open database")).toBe(false);
  });

  it("does not match a project error that merely mentions locking", () => {
    expect(isProjectLockedError("could not acquire lock on project")).toBe(false);
  });

  it("does not match null or undefined", () => {
    expect(isProjectLockedError(null)).toBe(false);
    expect(isProjectLockedError(undefined)).toBe(false);
  });
});

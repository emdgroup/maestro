import { describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePathNavigation } from "./usePathNavigation";

// Helpers to reduce boilerplate
function setup(isLocal = false, drives: string[] = []) {
  return renderHook(({ isLocal, drives }) => usePathNavigation(isLocal, drives), {
    initialProps: { isLocal, drives },
  });
}

describe("usePathNavigation – initial state", () => {
  it("starts with empty currentPath", () => {
    const { result } = setup();
    expect(result.current.currentPath).toBe("");
  });

  it("isDrivesRoot is false by default", () => {
    const { result } = setup();
    expect(result.current.isDrivesRoot).toBe(false);
  });
});

describe("usePathNavigation – navigateToDirectory (Unix)", () => {
  it("appends directory to empty path", () => {
    const { result } = setup();
    act(() => result.current.setCurrentPath("/home/user"));
    act(() => result.current.navigateToDirectory("projects"));
    expect(result.current.currentPath).toBe("/home/user/projects");
  });

  it("handles root / as base", () => {
    const { result } = setup();
    act(() => result.current.setCurrentPath("/"));
    act(() => result.current.navigateToDirectory("var"));
    expect(result.current.currentPath).toBe("/var");
  });

  it("handles Windows drive root (e.g., C:/)", () => {
    const { result } = setup(true, ["C:/", "D:/"]);
    act(() => result.current.setCurrentPath("C:/"));
    act(() => result.current.navigateToDirectory("Users"));
    expect(result.current.currentPath).toBe("C:/Users");
  });

  it("handles DRIVES_ROOT selection — sets path to selected drive", () => {
    const { result } = setup(true, ["C:/", "D:/"]);
    // Simulate being at DRIVES_ROOT
    act(() => result.current.setCurrentPath("<<DRIVES>>"));
    act(() => result.current.navigateToDirectory("C:/"));
    expect(result.current.currentPath).toBe("C:/");
  });
});

describe("usePathNavigation – navigateToParent (Unix)", () => {
  it("goes up one level", () => {
    const { result } = setup();
    act(() => result.current.setCurrentPath("/home/user/projects"));
    act(() => result.current.navigateToParent());
    expect(result.current.currentPath).toBe("/home/user");
  });

  it("goes to / when at top-level Unix directory", () => {
    const { result } = setup();
    act(() => result.current.setCurrentPath("/home"));
    act(() => result.current.navigateToParent());
    expect(result.current.currentPath).toBe("/");
  });

  it("does nothing at DRIVES_ROOT", () => {
    const { result } = setup(true, ["C:/"]);
    act(() => result.current.setCurrentPath("<<DRIVES>>"));
    act(() => result.current.navigateToParent());
    expect(result.current.currentPath).toBe("<<DRIVES>>");
  });

  it("goes to DRIVES_ROOT from Windows drive root (local with drives)", () => {
    const { result } = setup(true, ["C:/", "D:/"]);
    act(() => result.current.setCurrentPath("C:/"));
    act(() => result.current.navigateToParent());
    expect(result.current.currentPath).toBe("<<DRIVES>>");
  });

  it("goes to drive root when backing out of top Windows folder", () => {
    const { result } = setup(true, ["C:/"]);
    act(() => result.current.setCurrentPath("C:/Users"));
    act(() => result.current.navigateToParent());
    expect(result.current.currentPath).toBe("C:/");
  });
});

describe("usePathNavigation – navigateToBreadcrumb", () => {
  it("navigates to specific depth with index=-1 going to root", () => {
    const { result } = setup();
    act(() => result.current.setCurrentPath("/a/b/c"));
    act(() => result.current.navigateToBreadcrumb(-1));
    expect(result.current.currentPath).toBe("/");
  });

  it("navigates to first segment (index=0)", () => {
    const { result } = setup();
    act(() => result.current.setCurrentPath("/home/user/projects"));
    act(() => result.current.navigateToBreadcrumb(0));
    expect(result.current.currentPath).toBe("/home");
  });

  it("navigates to second segment (index=1)", () => {
    const { result } = setup();
    act(() => result.current.setCurrentPath("/home/user/projects"));
    act(() => result.current.navigateToBreadcrumb(1));
    expect(result.current.currentPath).toBe("/home/user");
  });

  it("navigates to DRIVES_ROOT for index=-1 on local Windows with drives", () => {
    const { result } = setup(true, ["C:/", "D:/"]);
    act(() => result.current.setCurrentPath("C:/Users/foo"));
    act(() => result.current.navigateToBreadcrumb(-1));
    expect(result.current.currentPath).toBe("<<DRIVES>>");
  });

  it("clicking drive letter breadcrumb sets path to drive root", () => {
    const { result } = setup(true, ["C:/"]);
    act(() => result.current.setCurrentPath("C:/Users/foo"));
    act(() => result.current.navigateToBreadcrumb(0)); // "C:" segment
    expect(result.current.currentPath).toBe("C:/");
  });
});

describe("usePathNavigation – pathParts", () => {
  it("returns empty array for empty path", () => {
    const { result } = setup();
    expect(result.current.pathParts).toEqual([]);
  });

  it("returns empty array for DRIVES_ROOT", () => {
    const { result } = setup(true, ["C:/"]);
    act(() => result.current.setCurrentPath("<<DRIVES>>"));
    expect(result.current.pathParts).toEqual([]);
  });

  it("returns path segments for Unix path", () => {
    const { result } = setup();
    act(() => result.current.setCurrentPath("/home/user/projects"));
    expect(result.current.pathParts).toEqual(["home", "user", "projects"]);
  });
});

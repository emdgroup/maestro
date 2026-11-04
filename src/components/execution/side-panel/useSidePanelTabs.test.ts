import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSidePanelTabs } from "./useSidePanelTabs";

function renderTabs() {
  return renderHook(() =>
    useSidePanelTabs({
      hasPlan: false,
      canvasMap: new Map(),
      hasArtifacts: false,
      changedFilesCount: null,
    }),
  );
}

const filesTabs = (r: ReturnType<typeof renderTabs>) =>
  r.result.current.tabs.filter((t) => t.kind === "files");

describe("opening files in the side panel", () => {
  it("opens one Files tab, focused, and hands every file link to it", () => {
    const r = renderTabs();
    act(() => r.result.current.openFile("src/a.ts", { from: 3, to: 4 }));
    act(() => r.result.current.openFile("src/b.ts"));

    expect(filesTabs(r)).toHaveLength(1);
    expect(r.result.current.activeTabId).toBe("files");
    expect(filesTabs(r)[0].openRequest).toMatchObject({ path: "src/b.ts" });
  });

  /** The panel acts on a new nonce, which is what flashes the lines of a link followed twice. */
  it("makes the same link followed twice a new request", () => {
    const r = renderTabs();
    act(() => r.result.current.openFile("src/a.ts", { from: 3, to: 4 }));
    const first = filesTabs(r)[0].openRequest!;
    act(() => r.result.current.openFile("src/a.ts", { from: 3, to: 4 }));

    expect(filesTabs(r)[0].openRequest!.nonce).not.toBe(first.nonce);
  });

  it("reuses the Files tab the + menu opened", () => {
    const r = renderTabs();
    act(() => r.result.current.openTabKind("files"));
    act(() => r.result.current.openTabKind("files"));
    act(() => r.result.current.openFile("src/a.ts"));

    expect(filesTabs(r)).toHaveLength(1);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { useEffect } from "react";
import { render, screen, act } from "@testing-library/react";
import { useSidePanelState, widthVerdict } from "./useSidePanelState";
import { useSidePanelTabs } from "../side-panel/useSidePanelTabs";
import type { CanvasSurface } from "../activity/types";

// Panel minimums: stream 42rem, side panel 22rem.
describe("widthVerdict", () => {
  it("collapses below the two panels' combined minimum", () => {
    expect(widthVerdict(63 * 16, 16)).toBe("collapse");
  });

  it("keeps the current state between the minimum and twice the stream minimum", () => {
    expect(widthVerdict(64 * 16, 16)).toBe("keep");
    expect(widthVerdict(83 * 16, 16)).toBe("keep");
  });

  it("allows auto-expand at twice the stream minimum", () => {
    expect(widthVerdict(84 * 16, 16)).toBe("may-expand");
  });

  it("scales with the root font size", () => {
    expect(widthVerdict(84 * 16, 20)).toBe("keep");
    expect(widthVerdict(63 * 20, 20)).toBe("collapse");
  });
});

// The panel's measured width, standing in for layout jsdom does not do. 0 is what a
// group inside AgentMonitor's `hidden` div reports.
let groupWidth = 0;
let observerCallback: ResizeObserverCallback | null = null;

class StubResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(cb: ResizeObserverCallback) {
    observerCallback = cb;
  }
}

Object.defineProperty(HTMLElement.prototype, "clientWidth", {
  configurable: true,
  get() {
    return this.dataset?.group === "1" ? groupWidth : 0;
  },
});
globalThis.ResizeObserver = StubResizeObserver;

function resizeGroupTo(width: number) {
  groupWidth = width;
  act(() => {
    observerCallback?.([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);
  });
}

/** The side panel wiring from AgentActivityPanel, without the rest of the session UI. */
function Harness({
  canvasMap,
  changedFilesCount = null,
}: {
  canvasMap: Map<string, CanvasSurface>;
  changedFilesCount?: number | null;
}) {
  const panel = useSidePanelState({
    isSelected: true,
    isPlanPermWithBody: false,
    pendingPermission: null,
    handlePermissionRespond: async () => {},
    setScrollRestoreToken: () => {},
  });
  const tabsState = useSidePanelTabs({
    hasPlan: false,
    canvasMap,
    hasArtifacts: false,
    changedFilesCount,
  });
  const { sidePanelCollapsed, expandAuto } = panel;
  const { activeTabId, markTabSeen, unseenTabIds } = tabsState;

  useEffect(() => {
    if (!sidePanelCollapsed) markTabSeen(activeTabId);
  }, [sidePanelCollapsed, activeTabId, markTabSeen]);

  useEffect(() => {
    if (unseenTabIds.size > 0) expandAuto();
  }, [unseenTabIds, expandAuto]);

  return (
    <div
      ref={panel.groupElementRef}
      data-group="1"
      data-testid="group"
      data-collapsed={String(sidePanelCollapsed)}
      data-tabs={tabsState.tabs.map((t) => t.id).join(",")}
      data-active={activeTabId}
      data-unseen={[...unseenTabIds].join(",")}
    >
      <button type="button" onClick={() => panel.setSidePanelCollapsed(false)}>
        open
      </button>
      <button type="button" onClick={panel.syncCollapsedFromPanel}>
        sync
      </button>
      <button type="button" onClick={() => tabsState.setActiveTabId("overview")}>
        go overview
      </button>
      <button type="button" onClick={() => tabsState.closeTab("review")}>
        close review
      </button>
    </div>
  );
}

const group = () => screen.getByTestId("group").dataset;
const collapsed = () => group().collapsed;
const withCanvas = () => new Map<string, CanvasSurface>([["surface-1", {} as CanvasSurface]]);

describe("side panel auto-expand", () => {
  beforeEach(() => {
    groupWidth = 0;
    observerCallback = null;
  });

  it("starts collapsed and opens itself when a tab arrives with room to spare", () => {
    const { rerender } = render(<Harness canvasMap={new Map()} />);
    resizeGroupTo(3000);
    expect(collapsed()).toBe("true");

    act(() => rerender(<Harness canvasMap={withCanvas()} />));
    expect(collapsed()).toBe("false");
  });

  it("stays collapsed when the width only fits both minimums", () => {
    const { rerender } = render(<Harness canvasMap={new Map()} />);
    resizeGroupTo(70 * 16);

    act(() => rerender(<Harness canvasMap={withCanvas()} />));
    expect(collapsed()).toBe("true");
  });

  it("keeps an open panel open while the session is hidden and measures 0", () => {
    render(<Harness canvasMap={new Map()} />);
    resizeGroupTo(3000);
    act(() => screen.getByText("open").click());
    expect(collapsed()).toBe("false");

    // Switching to another session hides this one: both the group's own observer and
    // the panel's onResize report a zero-width layout. Neither may close the panel.
    resizeGroupTo(0);
    act(() => screen.getByText("sync").click());
    expect(collapsed()).toBe("false");

    resizeGroupTo(3000);
    expect(collapsed()).toBe("false");
  });
});

describe("review tab on changed files", () => {
  // Narrow: the panel stays collapsed, which is where the unseen dot is read from.
  beforeEach(() => {
    groupWidth = 0;
    observerCallback = null;
  });

  const render0 = () => render(<Harness canvasMap={new Map()} changedFilesCount={0} />);
  const rerenderWith = (rerender: (ui: React.ReactElement) => void, count: number) =>
    act(() => rerender(<Harness canvasMap={new Map()} changedFilesCount={count} />));

  it("treats the first settled count as a baseline, not a change", () => {
    // A resumed session already has a diff — that must not pull the panel to Review.
    render(<Harness canvasMap={new Map()} changedFilesCount={3} />);
    expect(group().tabs).toBe("overview");
  });

  it("opens and flags Review on the session's first change", () => {
    const { rerender } = render0();
    rerenderWith(rerender, 2);

    expect(group().tabs).toBe("overview,review");
    expect(group().active).toBe("review");
    expect(group().unseen).toBe("review");
  });

  it("re-flags Review on later changes without stealing focus", () => {
    const { rerender } = render0();
    rerenderWith(rerender, 2);
    act(() => screen.getByText("open").click()); // marks the active tab seen
    act(() => screen.getByText("go overview").click());
    expect(group().unseen).toBe("");

    rerenderWith(rerender, 5);
    expect(group().unseen).toBe("review");
    expect(group().active).toBe("overview");
  });

  it("leaves a closed Review tab closed", () => {
    const { rerender } = render0();
    rerenderWith(rerender, 2);
    act(() => screen.getByText("close review").click());

    rerenderWith(rerender, 5);
    expect(group().tabs).toBe("overview");
    expect(group().unseen).toBe("");
  });
});

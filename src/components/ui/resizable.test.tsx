import { describe, it, expect, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "./resizable";

const VIEWPORT = window.innerHeight;
/** Beyond the slack `freezeLayout` keeps either side of the viewport. */
const FAR_BELOW = VIEWPORT * 2 + 100;

/**
 * One element off screen and one straddling it, each with rows. Only the styles are testable here
 * — that they save anything is a question about layout, and happy-dom does none.
 */
function renderGroup(disabled = false) {
  return render(
    <ResizablePanelGroup orientation="horizontal">
      <ResizablePanel>left</ResizablePanel>
      <ResizableHandle disabled={disabled} />
      <ResizablePanel>
        <div data-freeze-layout="tr" data-testid="offscreen">
          <table>
            <tbody>
              <tr data-testid="offscreen-row" />
            </tbody>
          </table>
        </div>
        <div data-freeze-layout="tr" data-testid="onscreen">
          <table>
            <tbody>
              <tr data-testid="row-above" />
              <tr data-testid="row-visible" />
              <tr data-testid="row-below" />
            </tbody>
          </table>
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>,
  );
}

/** happy-dom measures everything as 0, so each element is given the rect it stands for. */
function mockRects(rects: Record<string, Partial<DOMRect>>) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const rect = rects[this.dataset.testid ?? ""] ?? { top: 0, bottom: VIEWPORT };
    return { width: 0, height: 0, top: 0, bottom: 0, ...rect } as DOMRect;
  });
}

const LAYOUT = {
  offscreen: { width: 800, height: 4000, top: FAR_BELOW, bottom: FAR_BELOW + 4000 },
  "offscreen-row": { width: 800, height: 20, top: FAR_BELOW, bottom: FAR_BELOW + 20 },
  onscreen: { width: 800, height: 9000, top: -3000, bottom: 6000 },
  "row-above": { width: 800, height: 700, top: -VIEWPORT - 800, bottom: -VIEWPORT - 100 },
  "row-visible": { width: 800, height: 20, top: 10, bottom: 30 },
  "row-below": { width: 800, height: 300, top: FAR_BELOW, bottom: FAR_BELOW + 300 },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ResizableHandle", () => {
  it("skips off-screen content whole, and inside what is on screen only the rows out of view", () => {
    mockRects(LAYOUT);
    const { getByRole, getByTestId } = renderGroup();

    fireEvent.pointerDown(getByRole("separator"));

    // Off screen: skipped at its own size, its rows left alone because it is already gone.
    expect(getByTestId("offscreen").style.contentVisibility).toBe("hidden");
    expect(getByTestId("offscreen").style.containIntrinsicSize).toBe("800px 4000px");
    expect(getByTestId("offscreen-row").style.display).toBe("");

    // On screen: still laid out, so what the user sees follows the drag.
    expect(getByTestId("onscreen").style.contentVisibility).toBe("");
    expect(getByTestId("row-visible").style.display).toBe("");
    expect(getByTestId("row-above").style.display).toBe("none");
    expect(getByTestId("row-below").style.display).toBe("none");
    // Padded by exactly what the hidden rows took, so nothing below the drag moves.
    expect(getByTestId("onscreen").style.paddingTop).toBe("700px");
    expect(getByTestId("onscreen").style.paddingBottom).toBe("300px");
  });

  it("puts everything back when the drag ends", () => {
    mockRects(LAYOUT);
    const { getByRole, getByTestId } = renderGroup();

    fireEvent.pointerDown(getByRole("separator"));
    fireEvent.pointerUp(window);

    expect(getByTestId("offscreen").style.contentVisibility).toBe("");
    expect(getByTestId("offscreen").style.containIntrinsicSize).toBe("");
    expect(getByTestId("onscreen").style.paddingTop).toBe("");
    expect(getByTestId("onscreen").style.paddingBottom).toBe("");
    expect(getByTestId("row-above").style.display).toBe("");
    expect(getByTestId("row-below").style.display).toBe("");
  });

  it("puts everything back on a cancelled drag", () => {
    mockRects(LAYOUT);
    const { getByRole, getByTestId } = renderGroup();

    fireEvent.pointerDown(getByRole("separator"));
    fireEvent.pointerCancel(window);

    expect(getByTestId("offscreen").style.contentVisibility).toBe("");
    expect(getByTestId("row-below").style.display).toBe("");
  });

  it("freezes nothing for a disabled separator, which resizes nothing", () => {
    mockRects(LAYOUT);
    const { getByRole, getByTestId } = renderGroup(true);

    fireEvent.pointerDown(getByRole("separator"));

    expect(getByTestId("offscreen").style.contentVisibility).toBe("");
    expect(getByTestId("row-below").style.display).toBe("");
  });
});

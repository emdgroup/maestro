import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewLayout } from "./ReviewLayout";
import type { ReviewPanelState } from "./useReviewPanelLayout";

const onSelectFile = vi.fn();
const setPanelOpen = vi.fn();

/**
 * The hook's own behaviour is covered in `useReviewPanelLayout.test.tsx`. What matters here is only
 * which arrangement the layout draws for a given verdict, so the state is supplied directly.
 */
function panelState(overrides: Partial<ReviewPanelState> = {}): ReviewPanelState {
  return {
    containerRef: { current: null },
    layout: "overlay",
    inset: false,
    sidebarWidth: 256,
    trackSidebarWidth: vi.fn(),
    commitSidebarWidth: vi.fn(),
    panelOpen: true,
    setPanelOpen,
    ...overrides,
  } as ReviewPanelState;
}

const FILES = {
  files: [{ fileName: "NOTES.md", status: "A" as const }],
  selectedFile: null,
  onSelectFile,
  search: "",
  onSearchChange: vi.fn(),
};

beforeEach(() => {
  onSelectFile.mockClear();
  setPanelOpen.mockClear();
});

// Three hosts pass `files` and nothing else. Generalising the component for the Files tab must not
// have moved any of that.
describe("ReviewLayout with the review's own file panel", () => {
  it("draws the file list beside the diff when the panel is inset", () => {
    render(
      <ReviewLayout panel={panelState({ layout: "fixed", inset: true })} files={FILES}>
        <div>diff</div>
      </ReviewLayout>,
    );
    expect(screen.getByText("NOTES.md")).toBeTruthy();
    expect(screen.getByText("diff")).toBeTruthy();
  });

  it("floats it over the diff when there is no room, and dismisses it on a pick", async () => {
    render(
      <ReviewLayout panel={panelState()} files={FILES}>
        <div>diff</div>
      </ReviewLayout>,
    );
    await userEvent.click(screen.getByText("NOTES.md"));
    expect(onSelectFile).toHaveBeenCalledWith("NOTES.md");
    expect(setPanelOpen).toHaveBeenCalledWith(false);
  });

  it("draws no panel at all when it is closed", () => {
    render(
      <ReviewLayout panel={panelState({ panelOpen: false })} files={FILES}>
        <div>diff</div>
      </ReviewLayout>,
    );
    expect(screen.queryByText("NOTES.md")).toBeNull();
  });
});

// The Files tab's directory tree is not a list of changed files, so it comes in through a slot.
// Everything around it — where it sits, how the overlay is dismissed — stays this component's.
describe("ReviewLayout with a host-rendered panel", () => {
  const renderPanel = ({ onDismiss }: { onDismiss?: () => void }) => (
    <button type="button" onClick={() => onDismiss?.()}>
      tree
    </button>
  );

  it("seats it in the column, with no way to dismiss a column", () => {
    render(
      <ReviewLayout panel={panelState({ layout: "fixed", inset: true })} renderPanel={renderPanel}>
        <div>diff</div>
      </ReviewLayout>,
    );
    expect(screen.getByText("tree")).toBeTruthy();
    expect(screen.getByText("diff")).toBeTruthy();
  });

  it("floats it, handing it the dismissal the overlay needs", async () => {
    render(
      <ReviewLayout panel={panelState()} renderPanel={renderPanel}>
        <div>diff</div>
      </ReviewLayout>,
    );
    await userEvent.click(screen.getByText("tree"));
    expect(setPanelOpen).toHaveBeenCalledWith(false);
  });

  it("dismisses the floating panel on Escape, as the review's own does", async () => {
    render(
      <ReviewLayout panel={panelState()} renderPanel={renderPanel}>
        <div>diff</div>
      </ReviewLayout>,
    );
    await userEvent.keyboard("{Escape}");
    expect(setPanelOpen).toHaveBeenCalledWith(false);
  });
});

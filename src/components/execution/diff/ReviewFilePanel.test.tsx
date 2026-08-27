import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewFilePanel, ReviewFilePanelOverlay } from "./ReviewFilePanel";

const onSelectFile = vi.fn();
const onSearchChange = vi.fn();
const onDismiss = vi.fn();

const FILES = [
  { fileName: "src/acp/transport.rs", status: "M" as const },
  { fileName: "NOTES.md", status: "A" as const },
];

function props(overrides = {}) {
  return {
    files: FILES,
    selectedFile: null,
    onSelectFile,
    search: "",
    onSearchChange,
    ...overrides,
  };
}

beforeEach(() => {
  onSelectFile.mockClear();
  onSearchChange.mockClear();
  onDismiss.mockClear();
});

describe("ReviewFilePanel", () => {
  it("shows the files as a tree", () => {
    render(<ReviewFilePanel {...props()} />);
    expect(screen.getByText("src")).toBeTruthy();
    expect(screen.getByText("transport.rs")).toBeTruthy();
    expect(screen.getByText("NOTES.md")).toBeTruthy();
  });

  // Always tree in review — the toggle was a control for a choice nobody re-made.
  it("offers no flat/tree toggle", () => {
    render(<ReviewFilePanel {...props()} />);
    expect(screen.queryByText("Flat list")).toBeNull();
    expect(screen.queryByText("Tree view")).toBeNull();
  });

  // The host owns the filter text because it also clears it from the outside, to reveal a file
  // that comment navigation needs but the filter is hiding.
  it("reports typing rather than filtering on its own", async () => {
    render(<ReviewFilePanel {...props()} />);
    await userEvent.type(screen.getByPlaceholderText("Filter files..."), "n");
    expect(onSearchChange).toHaveBeenCalledWith("n");
  });

  it("filters to the controlled search value", () => {
    render(<ReviewFilePanel {...props({ search: "NOTES" })} />);
    expect(screen.getByText("NOTES.md")).toBeTruthy();
    expect(screen.queryByText("transport.rs")).toBeNull();
  });

  it("selects a file without dismissing anything", async () => {
    render(<ReviewFilePanel {...props()} />);
    await userEvent.click(screen.getByText("NOTES.md"));
    expect(onSelectFile).toHaveBeenCalledWith("NOTES.md");
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe("ReviewFilePanelOverlay", () => {
  it("dismisses after picking a file", async () => {
    render(<ReviewFilePanelOverlay {...props()} onDismiss={onDismiss} />);
    await userEvent.click(screen.getByText("NOTES.md"));
    expect(onSelectFile).toHaveBeenCalledWith("NOTES.md");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  // It covers the whole container, so there is no scrim to click — Escape is the way out that
  // does not also change what you are looking at.
  it("dismisses on Escape", async () => {
    render(<ReviewFilePanelOverlay {...props()} onDismiss={onDismiss} />);
    await userEvent.keyboard("{Escape}");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

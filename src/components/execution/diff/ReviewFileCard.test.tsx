import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewFileCard, fileNote } from "./ReviewFileCard";

const onToggleViewed = vi.fn();
const onToggleExpanded = vi.fn();
const onSubmit = vi.fn();
const onRemove = vi.fn();

const HUNKS = ["@@ -1,2 +1,3 @@\n context\n+added one\n+added two\n-removed one"];

function renderCard(props: Partial<Parameters<typeof ReviewFileCard>[0]> = {}) {
  return render(
    <ReviewFileCard
      path="src/acp/transport.rs"

      hunks={HUNKS}
      viewed={false}
      onToggleViewed={onToggleViewed}
      expanded
      onToggleExpanded={onToggleExpanded}
      fileComment={{ comment: null, onSubmit, onRemove }}
      {...props}
    >
      <div data-testid="diff-body">diff</div>
    </ReviewFileCard>,
  );
}

beforeEach(() => {
  onToggleViewed.mockClear();
  onToggleExpanded.mockClear();
  onSubmit.mockClear();
  onRemove.mockClear();
});

describe("ReviewFileCard", () => {
  it("shows the path and stats derived from the hunks", () => {
    renderCard();
    expect(screen.getByText("src/acp/transport.rs")).toBeTruthy();
    expect(screen.getByText("+2")).toBeTruthy();
    expect(screen.getByText("-1")).toBeTruthy();
  });

  // The status letter lives in the tree, where it sits in a column and reads as a legend. On the
  // card it was one more glyph in an already busy row.
  it("does not repeat the A/M/D status letter", () => {
    renderCard();
    for (const letter of ["A", "M", "D"]) {
      expect(screen.queryByText(letter)).toBeNull();
    }
  });

  it("renders the diff body when expanded and hides it when collapsed", () => {
    const { rerender } = renderCard();
    expect(screen.queryByTestId("diff-body")).toBeTruthy();

    rerender(
      <ReviewFileCard
        path="src/acp/transport.rs"
        hunks={HUNKS}
        viewed={false}
        onToggleViewed={onToggleViewed}
        expanded={false}
        onToggleExpanded={onToggleExpanded}
        fileComment={{ comment: null, onSubmit, onRemove }}
      >
        <div data-testid="diff-body">diff</div>
      </ReviewFileCard>,
    );
    expect(screen.queryByTestId("diff-body")).toBeNull();
  });

  // A rename or a binary file has no hunks; the card must say so rather than render an empty diff.
  it("renders a note instead of the body", () => {
    renderCard({ note: "Renamed from old.rs" });
    expect(screen.getByText("Renamed from old.rs")).toBeTruthy();
    expect(screen.queryByTestId("diff-body")).toBeNull();
  });

  it("makes the file name a button only when it can be opened elsewhere", async () => {
    const onOpenFile = vi.fn();
    const { unmount } = renderCard();
    expect(screen.queryByRole("button", { name: "src/acp/transport.rs" })).toBeNull();
    unmount();

    renderCard({ onOpenFile });
    await userEvent.click(screen.getByRole("button", { name: "src/acp/transport.rs" }));
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    // The header is click-to-collapse, so every control on it has to stop the event.
    expect(onToggleExpanded).not.toHaveBeenCalled();
  });

  it("toggles viewed without collapsing the card", async () => {
    renderCard();
    await userEvent.click(screen.getByRole("button", { name: "Mark as viewed" }));
    expect(onToggleViewed).toHaveBeenCalledTimes(1);
    expect(onToggleExpanded).not.toHaveBeenCalled();
  });

  it("copies the path without collapsing the card", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    renderCard();
    await userEvent.click(screen.getByRole("button", { name: "Copy path" }));
    expect(writeText).toHaveBeenCalledWith("src/acp/transport.rs");
    expect(onToggleExpanded).not.toHaveBeenCalled();
  });

  it("collapses when the header itself is clicked", async () => {
    renderCard();
    await userEvent.click(screen.getByText("src/acp/transport.rs"));
    expect(onToggleExpanded).toHaveBeenCalledTimes(1);
  });

  it("writes a file comment through onSubmit", async () => {
    renderCard();
    await userEvent.click(screen.getByRole("button", { name: "Add file comment" }));
    await userEvent.type(screen.getByPlaceholderText("Add a comment..."), "needs a test");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onSubmit).toHaveBeenCalledWith("needs a test");
  });

  // A note on a collapsed card would be invisible, so opening one has to open the card too.
  it("expands the card when a comment is added while collapsed", async () => {
    renderCard({ expanded: false });
    await userEvent.click(screen.getByRole("button", { name: "Add file comment" }));
    expect(onToggleExpanded).toHaveBeenCalledTimes(1);
  });

  it("anchors an existing comment so navigation can reach it", () => {
    const { container } = renderCard({
      fileComment: { comment: { id: "c1", text: "hoist this" }, onSubmit, onRemove },
    });
    expect(screen.getByText("hoist this")).toBeTruthy();
    expect(container.querySelector('[data-comment-id="c1"]')).toBeTruthy();
  });

  it("offers a send button only where comments leave one at a time", () => {
    const { unmount } = renderCard({
      fileComment: { comment: { id: "c1", text: "hoist this" }, onSubmit, onRemove },
    });
    expect(screen.queryByTitle("Send this annotation")).toBeNull();
    unmount();

    renderCard({
      fileComment: {
        comment: { id: "c1", text: "hoist this" },
        onSubmit,
        onRemove,
        onSend: vi.fn(),
      },
    });
    expect(screen.getByTitle("Send this annotation")).toBeTruthy();
  });
});

describe("fileNote", () => {
  it("is undefined when there is a diff to show", () => {
    expect(fileNote({ fileName: "a.ts", hunks: HUNKS })).toBeUndefined();
  });

  it("falls back to a generic note when git gave no reason", () => {
    expect(fileNote({ fileName: "a.png", hunks: [] })).toBe(
      "There is no line-by-line diff to show for this file.",
    );
    expect(fileNote({ fileName: "a.ts", hunks: [], note: "Renamed" })).toBe("Renamed");
  });
});

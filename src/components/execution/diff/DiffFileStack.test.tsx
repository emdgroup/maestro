import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRef } from "react";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DiffModeEnum } from "@git-diff-view/react";
import { setAutoIntersect, intersect, observedElements } from "@/test/intersection-observer";

// The stack's own wiring is what is under test, not the diff renderer — and the real one pulls in
// Shiki. The stub reports the per-file review props it was handed, which is the contract that
// matters here.
vi.mock("./DiffViewer", () => ({
  DiffViewer: ({
    comments,
    onAddComment,
    onSubmitComment,
  }: {
    comments?: Array<{ id: string; lineNumber: number }>;
    onAddComment?: (lineNumber: number, fromLineNumber: number, side: "old" | "new") => void;
    onSubmitComment?: (text: string) => void;
  }) => (
    <div data-testid="diff-viewer">
      {(comments ?? []).map((c) => (
        <span key={c.id} data-testid="line-comment">
          {c.id}:{c.lineNumber}
        </span>
      ))}
      {/* Stands in for a drag over the gutter followed by a click on the widget's `+`. The two
          steps are separate because the range has to survive between them. */}
      <button onClick={() => onAddComment?.(18, 12, "new")}>select 12-18</button>
      <button onClick={() => onSubmitComment?.("tighten this loop")}>submit draft</button>
    </div>
  ),
}));

import { DiffFileStack, type DiffFileStackHandle, type DiffReviewApi } from "./DiffFileStack";
import { useAnnotationStore } from "@/store/annotationStore";
import type { DiffAnnotation } from "@/store/annotationStore";
import type { DisplayItem } from "@/types/review";

const SESSION = 42;

function diffItem(name: string): DisplayItem {
  return { kind: "diff", file: { fileName: name, hunks: [`@@ -1 +1 @@\n+${name}`], status: "M" } };
}

const onSubmitComment = vi.fn();
const onRemoveComment = vi.fn();
const onEditComment = vi.fn();

function emptyReview(overrides: Partial<DiffReviewApi> = {}): DiffReviewApi {
  return {
    comments: [],
    onSubmitComment,
    onRemoveComment,
    onEditComment,
    ...overrides,
  };
}

function renderStack(
  items: DisplayItem[],
  review: DiffReviewApi,
  ref?: React.Ref<DiffFileStackHandle>,
) {
  return render(
    <DiffFileStack
      ref={ref}
      items={items}
      projectId={1}
      cwd="/tmp/wt"
      diffViewMode={DiffModeEnum.Unified}
      selectedIndex={0}
      onSelectedIndexChange={() => {}}
      viewedFiles={new Set()}
      onToggleViewed={() => {}}
      review={review}
    />,
  );
}

beforeEach(() => {
  onSubmitComment.mockClear();
  onRemoveComment.mockClear();
  onEditComment.mockClear();
});

describe("DiffFileStack", () => {
  it("renders a card per file", () => {
    renderStack([diffItem("a.ts"), diffItem("b.ts")], emptyReview());
    expect(screen.getByText("a.ts")).toBeTruthy();
    expect(screen.getByText("b.ts")).toBeTruthy();
  });

  it("submits a file comment as line 0", async () => {
    renderStack([diffItem("a.ts")], emptyReview());
    await userEvent.click(screen.getByRole("button", { name: "Add file comment" }));
    await userEvent.type(screen.getByPlaceholderText("Add a comment..."), "rename this");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onSubmitComment).toHaveBeenCalledWith("a.ts", 0, 0, "new", "rename this");
  });

  // Line 0 is the file's own note and is rendered by the card; anything else belongs in the diff.
  // `buildExtendData` drops line 0, so a leak here would make the note disappear entirely.
  it("keeps the file note out of the diff's line comments", async () => {
    const comments = [
      { id: "file", filePath: "a.ts", lineNumber: 0, side: "new" as const, text: "whole file" },
      { id: "line", filePath: "a.ts", lineNumber: 12, side: "new" as const, text: "this line" },
    ];
    renderStack([diffItem("a.ts")], emptyReview({ comments }));

    // The file note lives in the card, not the diff body, so it is there before any mount.
    expect(screen.getByText("whole file")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getAllByTestId("line-comment").map((n) => n.textContent)).toEqual(["line:12"]),
    );
  });

  it("does not leak one file's comments into another's", async () => {
    const comments = [
      { id: "a1", filePath: "a.ts", lineNumber: 3, side: "new" as const, text: "in a" },
      { id: "b1", filePath: "b.ts", lineNumber: 4, side: "new" as const, text: "in b" },
    ];
    renderStack([diffItem("a.ts"), diffItem("b.ts")], emptyReview({ comments }));
    await waitFor(() =>
      expect(screen.getAllByTestId("line-comment").map((n) => n.textContent)).toEqual([
        "a1:3",
        "b1:4",
      ]),
    );
  });

  // Every card opens expanded regardless of how many there are — the old >20 rule collapsed a
  // large review and made the reviewer click through each file.
  it("opens every file expanded regardless of count", async () => {
    renderStack(
      Array.from({ length: 30 }, (_, i) => diffItem(`f${i}.ts`)),
      emptyReview(),
    );
    await waitFor(() => expect(screen.getAllByTestId("diff-viewer")).toHaveLength(30));
  });

  // Expanded is not the same as mounted: the body waits for the card to come near the viewport,
  // which is what keeps a large review from building hundreds of Shiki-highlighted diffs at once.
  it("does not mount a body until its card is near the viewport", () => {
    setAutoIntersect(false);
    renderStack([diffItem("a.ts"), diffItem("b.ts")], emptyReview());

    expect(screen.queryAllByTestId("diff-viewer")).toHaveLength(0);
    // The card and its header are there — only the diff is deferred.
    expect(screen.getByText("a.ts")).toBeTruthy();
  });

  it("mounts a body once its card arrives", async () => {
    setAutoIntersect(false);
    const { container } = renderStack([diffItem("a.ts")], emptyReview());

    act(() => intersect(observedElements()));
    await waitFor(() => expect(screen.getAllByTestId("diff-viewer")).toHaveLength(1));
    expect(container).toBeTruthy();
  });

  // Never unmounting is what lets an open comment draft survive a scroll, and what keeps the
  // scroll-spy honest: heights above the viewport stay fixed once they are real.
  it("keeps a body mounted after its card scrolls away", async () => {
    setAutoIntersect(false);
    renderStack([diffItem("a.ts")], emptyReview());

    act(() => intersect(observedElements()));
    await waitFor(() => expect(screen.getAllByTestId("diff-viewer")).toHaveLength(1));

    act(() => intersect(observedElements(), false));
    expect(screen.getAllByTestId("diff-viewer")).toHaveLength(1);
  });

  // Comment navigation waits on a MutationObserver for the comment's node and gives up after a
  // couple of seconds. Without a forced mount, stepping to a comment in a far-off file would find
  // nothing and the chevron would silently do nothing.
  it("force-mounts a target the observer has not reached", () => {
    setAutoIntersect(false);
    const ref = createRef<DiffFileStackHandle>();
    renderStack(
      Array.from({ length: 30 }, (_, i) => diffItem(`f${i}.ts`)),
      emptyReview(),
      ref,
    );
    expect(screen.queryAllByTestId("diff-viewer")).toHaveLength(0);

    act(() => ref.current?.navigateTo(20));
    expect(screen.getAllByTestId("diff-viewer")).toHaveLength(1);
  });

  // The host sorts items into tree order; the stack must not reorder them, or the sidebar
  // highlight and the scroll position would disagree about which file is which.
  it("renders cards in the order given", () => {
    renderStack([diffItem("z.ts"), diffItem("a.ts"), diffItem("m.ts")], emptyReview());
    const names = screen.getAllByText(/\.ts$/).map((n) => n.textContent);
    expect(names).toEqual(["z.ts", "a.ts", "m.ts"]);
  });
});

/**
 * The point of keeping two stores: a review comment is a verdict that moves a task, an annotation
 * is a message to a live session. The interaction is one implementation, so the same script has to
 * land in whichever store the host wired up.
 */
describe("DiffReviewApi against a real store", () => {
  beforeEach(() => {
    act(() => useAnnotationStore.getState().clearSession(SESSION));
  });

  function annotationReview(): DiffReviewApi {
    const diffs = useAnnotationStore.getState().getAnnotations(SESSION, "diff") as DiffAnnotation[];
    return {
      comments: diffs,
      onSubmitComment: (filePath, lineNumber, fromLineNumber, side, text) => {
        const existing = diffs.find(
          (a) => a.filePath === filePath && a.lineNumber === lineNumber && a.side === side,
        );
        if (existing)
          useAnnotationStore
            .getState()
            .updateAnnotation(SESSION, existing.id, text, fromLineNumber);
        else
          useAnnotationStore.getState().addAnnotation(SESSION, {
            id: crypto.randomUUID(),
            kind: "diff",
            filePath,
            lineNumber,
            fromLineNumber,
            side,
            text,
          });
      },
      onRemoveComment: (id) => useAnnotationStore.getState().removeAnnotations(SESSION, [id]),
      onEditComment: (id, text) =>
        useAnnotationStore.getState().updateAnnotation(SESSION, id, text),
    };
  }

  it("writes a file note into annotationStore as a line-0 diff annotation", async () => {
    renderStack([diffItem("src/acp/manager.rs")], annotationReview());

    await userEvent.click(screen.getByRole("button", { name: "Add file comment" }));
    await userEvent.type(screen.getByPlaceholderText("Add a comment..."), "split this up");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    const stored = useAnnotationStore
      .getState()
      .getAnnotations(SESSION, "diff") as DiffAnnotation[];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      kind: "diff",
      filePath: "src/acp/manager.rs",
      lineNumber: 0,
      side: "new",
      text: "split this up",
    });
  });

  // The click that opens the composer and the submit that closes it are separate events, so the
  // selected range only survives if the stack holds on to both line numbers in between.
  it("carries a selected range from the widget click through to the store", async () => {
    renderStack([diffItem("src/git/merge.rs")], annotationReview());
    // The diff body is what carries the widget, and it only mounts once its card is on screen.
    act(() => intersect(observedElements()));

    await userEvent.click(screen.getByRole("button", { name: "select 12-18" }));
    await userEvent.click(screen.getByRole("button", { name: "submit draft" }));

    const stored = useAnnotationStore
      .getState()
      .getAnnotations(SESSION, "diff") as DiffAnnotation[];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      filePath: "src/git/merge.rs",
      lineNumber: 18,
      fromLineNumber: 12,
      side: "new",
      text: "tighten this loop",
    });
  });
});

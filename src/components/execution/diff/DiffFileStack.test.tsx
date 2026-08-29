import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRef } from "react";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DiffModeEnum } from "@git-diff-view/react";
import { setAutoIntersect, intersect, observedElements } from "@/test/intersection-observer";

// The stack's own wiring is what is under test, not the diff renderer — and the real one pulls in
// Shiki, plus a query for the file's pre-image that would need a QueryClient. The stub reports the
// per-file review props it was handed, which is the contract that matters here.
vi.mock("./ExpandableDiffViewer", () => ({
  ExpandableDiffViewer: ({
    comments,
    onAddComment,
    onSubmitComment,
    highlight,
  }: {
    comments?: Array<{ id: string; lineNumber: number }>;
    onAddComment?: (lineNumber: number, fromLineNumber: number, side: "old" | "new") => void;
    onSubmitComment?: (text: string) => void;
    highlight?: boolean;
  }) => (
    <div data-testid="diff-viewer" data-highlight={highlight ? "on" : "off"}>
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
      diffTarget={{ type: "Head" }}
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

  /**
   * No file-count rule. Thirty files arrive with every card open, exactly as three would — the old
   * `>20` rule folded a large review shut and made the reviewer click through each file.
   *
   * Open is not the same as built. Which bodies exist is decided by where the reader is, and a card
   * whose body has not been built yet is still an open card: the header carries `rounded-t-lg`,
   * meeting the body below it, rather than the `rounded-lg` of one the user has folded.
   */
  it("leaves every card open however many files there are", () => {
    renderStack(
      Array.from({ length: 30 }, (_, i) => diffItem(`f${i}.ts`)),
      emptyReview(),
    );

    const headers = Array.from(
      document.querySelectorAll<HTMLElement>("[data-file-card] > div > div"),
    );
    expect(headers).toHaveLength(30);
    expect(headers.filter((header) => header.className.includes("rounded-t-lg"))).toHaveLength(30);
  });

  /**
   * Headers always, bodies only near the viewport.
   *
   * Bodies are what a review costs — measured at ~35ms and ~1,300 DOM nodes a file, so rendering
   * all of a 151-file diff took 5.4s and 200k nodes. Headers are a few nodes each, and having all
   * of them is what keeps the stack an honestly measurable document: every card has a real
   * position, including files nobody has scrolled to.
   */
  it("renders a header for every file and a body only for what is near the viewport", () => {
    setAutoIntersect(false);
    renderStack([diffItem("a.ts"), diffItem("b.ts")], emptyReview());

    expect(screen.getByText("a.ts")).toBeTruthy();
    expect(screen.getByText("b.ts")).toBeTruthy();
    expect(screen.queryAllByTestId("diff-viewer")).toHaveLength(0);
  });

  /**
   * Two tiers off one margin: arriving builds the body, and queues the colour behind it. Plain
   * first is not a cosmetic choice — it is the half of the cost that can be deferred without
   * changing the layout, so it lands a frame later than the body it belongs to.
   */
  it("builds a body and then colours it once the card comes near the viewport", async () => {
    setAutoIntersect(false);
    renderStack([diffItem("a.ts")], emptyReview());

    act(() => intersect(observedElements()));

    await waitFor(() => expect(screen.getByTestId("diff-viewer")).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId("diff-viewer").dataset.highlight).toBe("on"));
  });

  // Colour is never taken back, so returning to a file costs nothing and no card is ever seen to
  // lose it. There is nothing to reclaim by dropping it — the DOM stays either way.
  it("keeps a card highlighted after it scrolls away", async () => {
    setAutoIntersect(false);
    renderStack([diffItem("a.ts")], emptyReview());

    act(() => intersect(observedElements()));
    await waitFor(() => expect(screen.getByTestId("diff-viewer").dataset.highlight).toBe("on"));

    act(() => intersect(observedElements(), false));

    expect(screen.getByTestId("diff-viewer").dataset.highlight).toBe("on");
  });

  /**
   * One a frame, not one batch. `DiffView` tokenises inside synchronous effects and React flushes
   * effects one component at a time without yielding, so a commit that starts five cards blocks
   * for the sum of all five and paints nothing until the last finishes.
   */
  it("builds one card a frame rather than all at once", async () => {
    // Hand-driven frames. `act()` drains happy-dom's timer queue in one go, so against the real
    // `requestAnimationFrame` five cards light up together and the test would pass either way.
    const pending: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => pending.push(cb));
    const nextFrame = async () => {
      const callback = pending.shift();
      if (callback) await act(async () => void callback(0));
    };

    try {
      setAutoIntersect(false);
      renderStack(
        Array.from({ length: 5 }, (_, i) => diffItem(`f${i}.ts`)),
        emptyReview(),
      );
      const built = () => screen.queryAllByTestId("diff-viewer").length;
      const lit = () =>
        screen.queryAllByTestId("diff-viewer").filter((v) => v.dataset.highlight === "on").length;

      act(() => intersect(observedElements()));
      // The observer callback queues; it builds nothing itself.
      expect(built()).toBe(0);

      await nextFrame();
      expect(built()).toBe(1);

      // The rest arrive over subsequent frames, colour trailing its own body by one.
      for (let round = 0; round < 20; round++) await nextFrame();
      expect(built()).toBe(5);
      expect(lit()).toBe(5);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  /**
   * Both tiers at once for a navigation target, ahead of anything queued. Comment navigation waits
   * on a MutationObserver for the comment's node and gives up after a couple of seconds, so a
   * target whose body has not been built has nothing for it to find; and a file the user asked for
   * should be readable on arrival rather than a frame later.
   */
  it("builds and colours a navigation target ahead of the queue", () => {
    setAutoIntersect(false);
    const ref = createRef<DiffFileStackHandle>();
    renderStack(
      Array.from({ length: 30 }, (_, i) => diffItem(`f${i}.ts`)),
      emptyReview(),
      ref,
    );
    expect(screen.queryAllByTestId("diff-viewer")).toHaveLength(0);

    act(() => ref.current?.navigateTo(20));

    const built = screen.getAllByTestId("diff-viewer");
    expect(built).toHaveLength(1);
    expect(built[0].dataset.highlight).toBe("on");
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
    // The diff body is what carries the widget, and it is built a frame after its card arrives.
    act(() => intersect(observedElements()));
    await waitFor(() => expect(screen.getByRole("button", { name: "select 12-18" })).toBeTruthy());

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

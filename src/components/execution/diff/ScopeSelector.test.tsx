import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ScopeSelector } from "./ScopeSelector";
import { commitSpan, fillSpan, scopeToDiffTarget, type DiffScope } from "./scope";
import type { CommitInfo } from "@/types/bindings";

const onScopeChange = vi.fn();

// git log order: newest first.
const COMMITS: CommitInfo[] = [
  { sha: "ccc3333", message: "Retire legacy module", committed_at: "2026-08-26T14:00:00Z" },
  { sha: "bbb2222", message: "Guard against empty input", committed_at: "2026-08-26T12:00:00Z" },
  { sha: "aaa1111", message: "Add retry helper", committed_at: "2026-08-25T09:00:00Z" },
];

function renderSelector(props: Partial<Parameters<typeof ScopeSelector>[0]> = {}) {
  return render(
    <ScopeSelector
      selectedScope={{ type: "all" }}
      onScopeChange={onScopeChange}
      commits={COMMITS}
      uncommittedFileCount={17}
      allChangesFileCount={31}
      {...props}
    />,
  );
}

async function open() {
  await userEvent.click(screen.getByRole("button", { name: /All changes|Uncommitted|commits/ }));
}

/** The popover's own subtree — the trigger repeats the selected scope's label outside it. */
function popover() {
  return screen.getByRole("dialog");
}

beforeEach(() => onScopeChange.mockClear());

describe("ScopeSelector", () => {
  // The count describes the "All changes" option, not the current view. Deriving it from the
  // selected scope's diff made the same option report a different size each time it was opened.
  it("reports the same All changes count whatever is selected", async () => {
    const { unmount } = renderSelector();
    await open();
    expect(screen.getByText("31 files · 3 commits")).toBeTruthy();
    unmount();

    renderSelector({ selectedScope: { type: "uncommitted" } });
    await open();
    expect(screen.getByText("31 files · 3 commits")).toBeTruthy();
  });

  it("shows commits by age rather than a file count", async () => {
    renderSelector();
    await open();
    expect(screen.getByText("Retire legacy module")).toBeTruthy();
    expect(screen.queryByText(/^\d+f$/)).toBeNull();
    // date-fns phrasing varies with distance; any "ago" is the signal.
    expect(screen.getAllByText(/ago$/).length).toBeGreaterThan(0);
  });

  // The accent fill means "the pointer is here", as it does in every menu in the app, and it
  // always brings `text-accent-foreground` with it — the pair is what keeps a mid-lightness fill
  // readable. Selection is the accent *text*, so no row sits permanently lit.
  it("marks selection with accent text and reserves the accent fill for hover", async () => {
    renderSelector();
    await open();
    const title = within(popover()).getByText("All changes");
    const row = title.closest("button");

    expect(row?.className).toContain("hover:bg-accent");
    expect(row?.className).toContain("hover:text-accent-foreground");
    expect(row?.className).not.toMatch(/(^|\s)bg-accent/);
    expect(title.className).toContain("text-accent");

    const other = within(popover()).getByText("Uncommitted");
    expect(other.className).not.toMatch(/(^|\s)text-accent(\s|$)/);
  });

  // The boxes say which commits the diff on screen covers, not only which ones a half-built
  // range has collected.
  it("ticks the commits the current scope already covers", async () => {
    renderSelector({ selectedScope: { type: "commits", oldest: "bbb2222", newest: "ccc3333" } });
    await open();
    expect(screen.getByRole("checkbox", { name: /ccc3333/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /bbb2222/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /aaa1111/ })).not.toBeChecked();
  });

  it("picks a single commit as a one-long range", async () => {
    renderSelector();
    await open();
    await userEvent.click(screen.getByText("Guard against empty input"));
    expect(onScopeChange).toHaveBeenCalledWith({
      type: "commits",
      oldest: "bbb2222",
      newest: "bbb2222",
    });
  });

  it("has no range footer until a commit is ticked", async () => {
    renderSelector();
    await open();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();

    await userEvent.click(screen.getByRole("checkbox", { name: /ccc3333/ }));
    expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy();
  });

  // Git can only diff a contiguous range, so ticking two ends fills the middle rather than
  // leaving a checkbox that cannot be honoured.
  it("fills the span between two non-adjacent commits", async () => {
    renderSelector();
    await open();
    await userEvent.click(screen.getByRole("checkbox", { name: /ccc3333/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /aaa1111/ }));

    expect(screen.getByText("aaa1111…ccc3333")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onScopeChange).toHaveBeenCalledWith({
      type: "commits",
      oldest: "aaa1111",
      newest: "ccc3333",
    });
  });

  it("clears a range without closing the popover", async () => {
    renderSelector();
    await open();
    await userEvent.click(screen.getByRole("checkbox", { name: /ccc3333/ }));
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    expect(within(popover()).getByText("All changes")).toBeTruthy();
    expect(onScopeChange).not.toHaveBeenCalled();
  });
});

describe("scope helpers", () => {
  it("maps a span to oldest and newest across git's newest-first order", () => {
    expect(commitSpan(new Set(["ccc3333", "aaa1111"]), COMMITS)).toEqual({
      newest: "ccc3333",
      oldest: "aaa1111",
    });
    expect(commitSpan(new Set(), COMMITS)).toBeNull();
  });

  it("fills a span inclusively in either direction", () => {
    expect(fillSpan(COMMITS, "ccc3333", "aaa1111")).toEqual(
      new Set(["ccc3333", "bbb2222", "aaa1111"]),
    );
    expect(fillSpan(COMMITS, "aaa1111", "ccc3333").size).toBe(3);
    expect(fillSpan(COMMITS, "bbb2222", "bbb2222")).toEqual(new Set(["bbb2222"]));
  });

  // A single commit has to produce exactly the diff it always did.
  it("maps a one-long range to that commit's own changes", () => {
    const scope: DiffScope = { type: "commits", oldest: "bbb2222", newest: "bbb2222" };
    expect(scopeToDiffTarget(scope, {})).toEqual({
      type: "CommitRange",
      from: "bbb2222~1",
      to: "bbb2222",
    });
  });

  it("anchors All changes on the execution start sha when there is one", () => {
    expect(scopeToDiffTarget({ type: "all" }, { startSha: "abc", baseBranch: "main" })).toEqual({
      type: "Commit",
      sha: "abc",
    });
    expect(scopeToDiffTarget({ type: "all" }, { baseBranch: "main" })).toEqual({
      type: "BranchAll",
      branch: "main",
    });
    expect(scopeToDiffTarget({ type: "all" }, {})).toEqual({ type: "Head" });
  });
});

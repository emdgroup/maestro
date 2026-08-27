import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useCommentNavigation } from "./useCommentNavigation";

function comment(id: string, filePath: string, lineNumber: number) {
  return { id, filePath, lineNumber };
}

/**
 * A container holding one `data-comment-id` node per id, as DiffViewer tags them.
 *
 * `scrollIntoView` is stubbed per node rather than on `Element.prototype`: `goToComment` polls
 * across animation frames and does not stop when a test ends, so a shared spy counts the previous
 * test's reveals as well as this one's.
 */
function containerWith(...ids: string[]) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const scrolls = new Map<string, ReturnType<typeof vi.fn>>();

  const add = (id: string) => {
    const node = document.createElement("div");
    node.setAttribute("data-comment-id", id);
    const spy = vi.fn();
    node.scrollIntoView = spy;
    scrolls.set(id, spy);
    el.appendChild(node);
  };

  ids.forEach(add);
  return { ref: { current: el }, scrolls, add };
}

function setup(
  comments: ReturnType<typeof comment>[],
  fileOrder: string[],
  container: { current: HTMLElement | null },
  revealFile = vi.fn(),
) {
  const { result } = renderHook(() =>
    useCommentNavigation({ comments, fileOrder, revealFile, container }),
  );
  return { result, revealFile };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("useCommentNavigation", () => {
  it("orders by file as the host lists them, then by line", () => {
    const { result } = setup(
      [comment("b2", "b.ts", 5), comment("a2", "a.ts", 90), comment("a1", "a.ts", 12)],
      ["a.ts", "b.ts"],
      containerWith().ref,
    );
    expect(result.current.orderedComments.map((c) => c.id)).toEqual(["a1", "a2", "b2"]);
  });

  // A comment can outlive its file's place in the list — a scope change drops the file from the
  // diff while the note is still pending. It must not fall out of the sequence.
  it("sorts a comment on an unlisted file last rather than dropping it", () => {
    const { result } = setup(
      [comment("gone", "removed.ts", 1), comment("a1", "a.ts", 12)],
      ["a.ts"],
      containerWith().ref,
    );
    expect(result.current.orderedComments.map((c) => c.id)).toEqual(["a1", "gone"]);
  });

  it("offers no navigation below two comments", () => {
    const empty = setup([], [], containerWith().ref);
    expect(empty.result.current.commentNav("nope")).toBeNull();

    const one = setup([comment("a1", "a.ts", 1)], ["a.ts"], containerWith("a1").ref);
    expect(one.result.current.commentNav("a1")).toBeNull();
  });

  it("reports a 1-based position and wraps at both ends", () => {
    // One comment per file, so which one a step landed on is readable from revealFile.
    const { result, revealFile } = setup(
      [comment("a1", "a.ts", 1), comment("b1", "b.ts", 2), comment("c1", "c.ts", 3)],
      ["a.ts", "b.ts", "c.ts"],
      containerWith("a1", "b1", "c1").ref,
    );

    expect(result.current.commentNav("b1")?.position).toEqual([2, 3]);

    result.current.commentNav("a1")?.onPrev();
    expect(revealFile).toHaveBeenLastCalledWith("c.ts");

    result.current.commentNav("c1")?.onNext();
    expect(revealFile).toHaveBeenLastCalledWith("a.ts");
  });

  it("reveals the comment's file and scrolls to it", async () => {
    const container = containerWith("a1", "b1");
    const { result, revealFile } = setup(
      [comment("a1", "a.ts", 1), comment("b1", "b.ts", 4)],
      ["a.ts", "b.ts"],
      container.ref,
    );

    result.current.goToComment("b1");

    expect(revealFile).toHaveBeenCalledWith("b.ts");
    await waitFor(() => expect(container.scrolls.get("b1")).toHaveBeenCalled());
    expect(container.scrolls.get("a1")).not.toHaveBeenCalled();
  });

  // The reason goToComment polls instead of waiting a fixed delay: in task review the node only
  // exists once the file is on screen and its diff has been highlighted, which is slower than any
  // timeout worth hard-coding.
  it("waits for a node that only mounts after the file is revealed", async () => {
    const container = containerWith("a1");
    const revealFile = vi.fn((path: string) => {
      if (path === "b.ts") setTimeout(() => container.add("b1"), 30);
    });

    const { result } = setup(
      [comment("a1", "a.ts", 1), comment("b1", "b.ts", 4)],
      ["a.ts", "b.ts"],
      container.ref,
      revealFile,
    );

    result.current.goToComment("b1");
    expect(container.scrolls.get("b1")).toBeUndefined();

    await waitFor(() => expect(container.scrolls.get("b1")).toHaveBeenCalled());
  });

  it("does nothing for an id that is not in the review", () => {
    const container = containerWith("a1", "a2");
    const { result, revealFile } = setup(
      [comment("a1", "a.ts", 1), comment("a2", "a.ts", 2)],
      ["a.ts"],
      container.ref,
    );

    result.current.goToComment("ghost");

    expect(revealFile).not.toHaveBeenCalled();
  });
});

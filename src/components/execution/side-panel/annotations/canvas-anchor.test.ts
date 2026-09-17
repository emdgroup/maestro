import { describe, it, expect } from "vitest";
import { isStale, pickAt, pickInRect, toCanvasNodes, uncapturableKinds } from "./canvas-anchor";
import type { FrameNode } from "@/components/execution/activity/canvas/CanvasHtml";

/**
 * The rules are pure functions over a node list, and the list is what the frame reports — so the
 * fixtures are exactly the shape a real surface sends across, and nothing here needs layout.
 */
function node(
  id: string,
  tag: string,
  parentId: string | null,
  [left, top, width, height]: [number, number, number, number],
  extra: Partial<FrameNode> = {},
): FrameNode {
  return {
    id,
    parentId,
    tag,
    className: "",
    role: "",
    ownText: true,
    childCount: 0,
    rect: { left, top, width, height },
    ...extra,
  };
}

/** A stat tile: a framed card wrapping a label and a value, beside a chart. */
const tile = toCanvasNodes(
  [
    node("col", "div", null, [0, 0, 400, 300], { ownText: false, childCount: 3 }),
    node("card", "div", "col", [10, 10, 180, 80], {
      className: "rounded-lg border card",
      ownText: false,
      childCount: 2,
    }),
    node("label", "span", "card", [20, 20, 60, 20]),
    node("value", "span", "card", [20, 50, 100, 30]),
    node("chart", "svg", "col", [10, 110, 380, 150]),
    node("rule", "hr", "col", [10, 100, 380, 4]),
  ],
  { left: 0, top: 0 },
);

describe("toCanvasNodes", () => {
  it("offsets the frame's rects by where the frame sits", () => {
    const [only] = toCanvasNodes([node("a", "div", null, [10, 20, 30, 40])], {
      left: 100,
      top: 200,
    });
    expect([only.rect.left, only.rect.top]).toEqual([110, 220]);
  });
});

describe("pickAt", () => {
  it("picks the card, not the text inside it", () => {
    expect(pickAt(tile, 60, 60)).toBe("card");
  });

  it("drills to the innermost element when asked", () => {
    expect(pickAt(tile, 60, 60, { drill: true })).toBe("value");
  });

  it("picks a bare element where no card encloses it", () => {
    expect(pickAt(tile, 200, 180)).toBe("chart");
  });

  it("never picks a layout wrapper, so its gaps select nothing", () => {
    expect(pickAt(tile, 300, 95)).toBeNull();
  });

  it("looks straight through a rule", () => {
    // The pointer is over the `hr`, which sits in the column's gap and is skipped.
    expect(pickAt(tile, 100, 102)).toBeNull();
  });

  it("returns null outside every element", () => {
    expect(pickAt(tile, 900, 900)).toBeNull();
  });
});

describe("pickInRect", () => {
  const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, right: left + width, bottom: top + height, width, height }) as DOMRect;

  it("selects an element the marquee only clips", () => {
    expect(pickInRect(tile, rect(0, 100, 100, 100))).toContain("chart");
  });

  it("reduces a covered card to itself, dropping its children", () => {
    expect(pickInRect(tile, rect(0, 0, 300, 100))).toEqual(["card"]);
  });

  it("keeps siblings side by side", () => {
    expect(pickInRect(tile, rect(0, 0, 400, 300)).sort()).toEqual(["card", "chart"]);
  });

  it("selects nothing over empty space", () => {
    expect(pickInRect(tile, rect(600, 600, 50, 50))).toEqual([]);
  });
});

describe("isStale", () => {
  it("is stale once every annotated element is gone", () => {
    expect(isStale(tile, ["removed-a", "removed-b"])).toBe(true);
  });

  it("is not stale while one survives", () => {
    expect(isStale(tile, ["removed-a", "chart"])).toBe(false);
  });

  it("is never stale for a note anchored to the surface alone", () => {
    expect(isStale(tile, [])).toBe(false);
  });
});

describe("uncapturableKinds", () => {
  const withVideo = toCanvasNodes(
    [
      node("col", "div", null, [0, 0, 400, 300], { ownText: false, childCount: 2 }),
      node("clip", "video", "col", [0, 0, 200, 100]),
      node("chart", "svg", "col", [0, 120, 200, 100]),
    ],
    { left: 0, top: 0 },
  );

  it("reports the elements a screenshot cannot show", () => {
    expect(uncapturableKinds(withVideo, ["clip", "chart"])).toEqual(["video"]);
  });

  it("reports nothing for a region that rasterises fully", () => {
    expect(uncapturableKinds(withVideo, ["chart"])).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { isStale, pickAt, pickInRect, uncapturableKinds, type CanvasNode } from "./canvas-anchor";

/**
 * The rules are pure functions over a node list, so the tree is built out of plain objects with
 * real elements for ancestry — happy-dom has no layout, but `Node.contains` works, and that is the
 * only DOM behaviour these rules depend on.
 */
function tree(
  spec: Array<{
    id: string;
    kind: string;
    parent?: string;
    rect: [number, number, number, number];
  }>,
): CanvasNode[] {
  const els = new Map<string, HTMLElement>();
  for (const { id, parent } of spec) {
    const el = document.createElement("div");
    els.set(id, el);
    if (parent) els.get(parent)?.appendChild(el);
  }
  return spec.map(({ id, kind, rect: [left, top, width, height] }) => ({
    id,
    kind,
    el: els.get(id)!,
    rect: { left, top, right: left + width, bottom: top + height, width, height } as DOMRect,
  }));
}

/** A stat tile: a framed Card wrapping a label and a value. */
const tile = tree([
  { id: "col", kind: "Column", rect: [0, 0, 400, 300] },
  { id: "card", kind: "Card", parent: "col", rect: [10, 10, 180, 80] },
  { id: "label", kind: "Text", parent: "card", rect: [20, 20, 60, 20] },
  { id: "value", kind: "Text", parent: "card", rect: [20, 50, 100, 30] },
  { id: "chart", kind: "Chart", parent: "col", rect: [10, 110, 380, 150] },
  { id: "rule", kind: "Divider", parent: "col", rect: [10, 100, 380, 4] },
]);

describe("pickAt", () => {
  it("picks the card, not the text inside it", () => {
    expect(pickAt(tile, 60, 60)).toBe("card");
  });

  it("drills to the innermost component when asked", () => {
    expect(pickAt(tile, 60, 60, { drill: true })).toBe("value");
  });

  it("picks a bare component where no card encloses it", () => {
    expect(pickAt(tile, 200, 180)).toBe("chart");
  });

  it("never picks a layout wrapper, so its gaps select nothing", () => {
    expect(pickAt(tile, 300, 95)).toBeNull();
  });

  it("looks straight through a divider", () => {
    // The pointer is over the rule, which sits in the Column's gap and is skipped.
    expect(pickAt(tile, 100, 102)).toBeNull();
  });

  it("returns null outside every component", () => {
    expect(pickAt(tile, 900, 900)).toBeNull();
  });
});

describe("pickInRect", () => {
  const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, right: left + width, bottom: top + height, width, height }) as DOMRect;

  it("selects a component the marquee only clips", () => {
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
  it("is stale once every annotated component is gone", () => {
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
  const withIframe = tree([
    { id: "col", kind: "Column", rect: [0, 0, 400, 300] },
    { id: "widget", kind: "Html", parent: "col", rect: [0, 0, 200, 100] },
    { id: "chart", kind: "Chart", parent: "col", rect: [0, 120, 200, 100] },
  ]);

  it("reports the components a screenshot cannot show", () => {
    expect(uncapturableKinds(withIframe, ["widget", "chart"])).toEqual(["Html"]);
  });

  it("reports nothing for a region that rasterises fully", () => {
    expect(uncapturableKinds(withIframe, ["chart"])).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import {
  NO_TABS,
  canSplit,
  closeTab,
  closeTabs,
  dropTab,
  dropTargetAt,
  focusSide,
  joinSides,
  moveTab,
  openTab,
  openToSide,
  removePaths,
  renamePaths,
  type DropLayout,
  type FileTabsState,
} from "./file-tabs";

const open = (...paths: string[]) => paths.reduce<FileTabsState>((s, p) => openTab(s, p), NO_TABS);
const rows = (s: FileTabsState) => s.groups.map((g) => g.tabs.join(","));

describe("file tabs", () => {
  it("opens each file once and focuses it when opened again", () => {
    const s = openTab(open("a", "b"), "a");
    expect(rows(s)).toEqual(["a,b"]);
    expect(s.groups[0].active).toBe("a");
  });

  it("focuses a file open on the other side instead of opening it twice", () => {
    const s = openTab({ ...openToSide(open("a", "b"), "b"), focus: 0 }, "b");
    expect(rows(s)).toEqual(["a", "b"]);
    expect(s.focus).toBe(1);
  });

  it("opens a split by sending a tab to the side, and closes it when that side empties", () => {
    const split = openToSide(open("a", "b"), "b");
    expect(rows(split)).toEqual(["a", "b"]);
    expect(split.focus).toBe(1);
    const joined = closeTab(split, 1, "b");
    expect(rows(joined)).toEqual(["a"]);
    expect(joined.focus).toBe(0);
  });

  it("keeps the second side when the first empties, as the only side", () => {
    const s = closeTab(openToSide(open("a", "b"), "b"), 0, "a");
    expect(rows(s)).toEqual(["b"]);
    expect(s.focus).toBe(0);
  });

  it("leaves one empty side when the last tab closes", () => {
    expect(closeTab(open("a"), 0, "a")).toEqual(NO_TABS);
  });

  it("shows the right neighbour of a closed tab, then the left one", () => {
    expect(closeTab(openTab(open("a", "b", "c"), "b"), 0, "b").groups[0].active).toBe("c");
    expect(closeTab(open("a", "b", "c"), 0, "c").groups[0].active).toBe("b");
  });

  it("closes the tabs to the right except the ones it is told to keep", () => {
    const s = closeTabs(open("a", "b", "c", "d"), 0, (p, i) => i > 0 && p !== "c");
    expect(rows(s)).toEqual(["a,c"]);
  });

  it("reorders within a side", () => {
    expect(rows(moveTab(open("a", "b", "c"), 0, "c", 0, 0))).toEqual(["c,a,b"]);
    expect(rows(moveTab(open("a", "b", "c"), 0, "a", 0, 2))).toEqual(["b,a,c"]);
  });

  it("moves across sides, and a drop on the right half opens the second side", () => {
    const split = moveTab(open("a", "b"), 0, "b", 1, Infinity);
    expect(rows(split)).toEqual(["a", "b"]);
    const back = moveTab(split, 1, "b", 0, 0);
    expect(rows(back)).toEqual(["b,a"]);
    expect(back.focus).toBe(0);
  });

  it("joins the sides into one when the room for two is gone", () => {
    const s = joinSides(openToSide(open("a", "b"), "b"));
    expect(rows(s)).toEqual(["a,b"]);
    expect(s.groups[0].active).toBe("b");
  });

  it("follows a renamed file or folder", () => {
    const s = renamePaths(open("src/a.ts", "src/b.ts", "x"), "src", "lib");
    expect(rows(s)).toEqual(["lib/a.ts,lib/b.ts,x"]);
    expect(s.groups[0].active).toBe("x");
  });

  it("closes the tabs of a deleted folder on both sides", () => {
    const s = removePaths(openToSide(open("src/a", "x", "src/b"), "src/b"), (p) =>
      p.startsWith("src/"),
    );
    expect(rows(s)).toEqual(["x"]);
  });

  it("never makes a third side", () => {
    const split = openToSide(open("a", "b", "c"), "c");
    expect(rows(moveTab(split, 0, "b", 2, Infinity))).toEqual(["a", "c,b"]);
  });

  it("ignores a side that is not there", () => {
    const s = open("a");
    expect(closeTabs(s, 3, () => true)).toBe(s);
    expect(focusSide(s, 3)).toBe(s);
  });

  it("keeps focus on the second side when the first empties under it", () => {
    const s = closeTab({ ...openToSide(open("a", "b"), "b"), focus: 1 }, 0, "a");
    expect(rows(s)).toEqual(["b"]);
    expect(s.focus).toBe(0);
  });

  it("opens to the side the focus is not on", () => {
    const split = openToSide(open("a", "b"), "b");
    expect(rows(openToSide(split, "c"))).toEqual(["a,c", "b"]);
  });

  it("splits only with the room for it and a tab that can leave, or a side already there", () => {
    expect(canSplit(open("a"), 0, true)).toBe(false);
    expect(canSplit(open("a", "b"), 0, true)).toBe(true);
    expect(canSplit(open("a", "b"), 0, false)).toBe(false);
    expect(canSplit(openToSide(open("a", "b"), "b"), 1, true)).toBe(true);
  });
});

describe("dropping a dragged tab", () => {
  const box = (left: number, top: number, right: number, bottom: number) => ({
    left,
    top,
    right,
    bottom,
  });
  // One side, 0-400 wide: its band of tabs on top, two tabs in it, the file below.
  const lone: DropLayout = {
    rows: [{ side: 0, band: box(0, 0, 400, 40), tabs: [box(10, 5, 90, 35), box(100, 5, 180, 35)] }],
    wells: [{ side: 0, box: box(0, 40, 400, 400) }],
  };
  const two = open("a", "b");

  it("lands between the tabs of a row, by the half of the tab the pointer is over", () => {
    expect(dropTargetAt(two, lone, 20, 20, { side: 0, path: "b" }, true)).toEqual({
      kind: "row",
      side: 0,
      index: 0,
    });
    expect(dropTargetAt(two, lone, 300, 20, { side: 0, path: "a" }, true)).toEqual({
      kind: "row",
      side: 0,
      index: 2,
    });
  });

  it("opens a second side on the right half of a lone file, and nowhere on the left", () => {
    const from = { side: 0, path: "b" };
    expect(dropTargetAt(two, lone, 300, 200, from, true)).toEqual({
      kind: "well",
      side: 0,
      zone: "right",
    });
    expect(dropTargetAt(two, lone, 100, 200, from, true)).toBeNull();
    expect(dropTargetAt(two, lone, 300, 200, from, false)).toBeNull();
    expect(dropTargetAt(open("a"), lone, 300, 200, { side: 0, path: "a" }, true)).toBeNull();
  });

  it("moves onto the other side's file, but not onto its own", () => {
    const split = openToSide(two, "b");
    const layout: DropLayout = {
      rows: [],
      wells: [
        { side: 0, box: box(0, 40, 200, 400) },
        { side: 1, box: box(200, 40, 400, 400) },
      ],
    };
    expect(dropTargetAt(split, layout, 100, 200, { side: 1, path: "b" }, true)).toEqual({
      kind: "well",
      side: 0,
      zone: "all",
    });
    expect(dropTargetAt(split, layout, 300, 200, { side: 1, path: "b" }, true)).toBeNull();
  });

  it("applies a drop as a reorder, a move across, or a new side", () => {
    const from = { side: 0, path: "b" };
    expect(rows(dropTab(two, { kind: "row", side: 0, index: 0 }, from))).toEqual(["b,a"]);
    expect(rows(dropTab(two, { kind: "well", side: 0, zone: "right" }, from))).toEqual(["a", "b"]);
    const split = openToSide(two, "b");
    expect(
      rows(dropTab(split, { kind: "well", side: 0, zone: "all" }, { side: 1, path: "b" })),
    ).toEqual(["a,b"]);
  });
});

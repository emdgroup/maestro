import { describe, it, expect } from "vitest";
import {
  NO_TABS,
  closeTab,
  closeTabs,
  joinSides,
  moveTab,
  openTab,
  openToSide,
  removePaths,
  renamePaths,
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
});

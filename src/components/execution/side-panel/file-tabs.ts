/**
 * The open files of a Files panel: one or two sides, each a row of tabs with one of them showing.
 *
 * A path is open on one side at most. Opening a file that is already open focuses its tab wherever
 * it is, and sending it to the other side moves it there, so there is never a second draft of the
 * same file to reconcile.
 *
 * A side left with no tabs closes, and with it the split. With one side, closing its last tab
 * leaves it empty rather than gone, because the panel always has somewhere to open a file.
 */
import type { LineRange } from "@/lib/path-utils";

/** A file for the panel to open, or focus if it is open, and the lines to flash in it. */
export interface FileOpenRequest {
  /** Relative to the workspace, or absolute for a file outside it. */
  path: string;
  lines?: LineRange;
  /** Changed for every request, so following the same link twice flashes its lines twice. */
  nonce: number;
}

export interface TabGroup {
  tabs: string[];
  active: string | null;
}

export interface FileTabsState {
  groups: TabGroup[];
  /** The side the tree opens files on and keyboard shortcuts act on. */
  focus: number;
}

export const NO_TABS: FileTabsState = { groups: [{ tabs: [], active: null }], focus: 0 };

/** The index of the last side there can be: two at most, side by side. */
const LAST_SIDE = 1;

export function sideOf(state: FileTabsState, path: string): number {
  return state.groups.findIndex((g) => g.tabs.includes(path));
}

/** The file on screen in the focused side. */
export function focusedPath(state: FileTabsState): string | null {
  return state.groups[state.focus]?.active ?? null;
}

/** The neighbour that takes over when `path` leaves a row. */
function neighbour(tabs: string[], path: string): string | null {
  const i = tabs.indexOf(path);
  return tabs[i + 1] ?? tabs[i - 1] ?? null;
}

/** Makes `side` the one the tree opens on, if there is such a side. */
export function focusSide(state: FileTabsState, side: number): FileTabsState {
  if (side === state.focus || !state.groups[side]) return state;
  return { ...state, focus: side };
}

/**
 * Whether a tab on `side` can go to the other side: the panel has the room, and there is a second
 * side already or a tab that can leave this one without emptying it.
 */
export function canSplit(state: FileTabsState, side: number, allowed: boolean): boolean {
  return allowed && (state.groups.length > 1 || (state.groups[side]?.tabs.length ?? 0) > 1);
}

/** Drops empty sides, keeping one, and keeps `focus` on the same side wherever it now sits. */
function settle(groups: TabGroup[], focus: number): FileTabsState {
  const kept = groups.filter((g) => g.tabs.length > 0);
  if (kept.length === 0) return NO_TABS;
  return { groups: kept, focus: Math.max(0, kept.indexOf(groups[focus])) };
}

/** Opens `path` on `side`, or focuses it wherever it already is when no side is asked for. */
export function openTab(state: FileTabsState, path: string, side?: number): FileTabsState {
  const at = sideOf(state, path);
  if (at >= 0 && (side === undefined || side === at)) {
    const groups = state.groups.map((g, i) => (i === at ? { ...g, active: path } : g));
    return { groups, focus: at };
  }
  const target = Math.min(side ?? state.focus, LAST_SIDE);
  if (at >= 0) return moveTab(state, at, path, target, Infinity);
  const groups = [...state.groups];
  if (target >= groups.length) groups.push({ tabs: [], active: null });
  groups[target] = { tabs: [...groups[target].tabs, path], active: path };
  return { groups, focus: target };
}

/** Opens `path` on the side that is not focused, creating it when there is only one. */
export function openToSide(state: FileTabsState, path: string): FileTabsState {
  return openTab(state, path, state.groups.length > 1 && state.focus === 1 ? 0 : 1);
}

/** Closes the tabs on `side` that `close` picks. */
export function closeTabs(
  state: FileTabsState,
  side: number,
  close: (path: string, index: number) => boolean,
): FileTabsState {
  const group = state.groups[side];
  if (!group) return state;
  const tabs = group.tabs.filter((p, i) => !close(p, i));
  if (tabs.length === group.tabs.length) return state;
  let active = group.active;
  if (active !== null && !tabs.includes(active)) {
    // The nearest survivor to the right, then to the left — where the eye already is.
    const from = group.tabs.indexOf(active);
    active =
      group.tabs.slice(from + 1).find((p) => tabs.includes(p)) ??
      group.tabs
        .slice(0, from)
        .reverse()
        .find((p) => tabs.includes(p)) ??
      null;
  }
  const groups = state.groups.map((g, i) => (i === side ? { tabs, active } : g));
  return settle(groups, state.focus);
}

export function closeTab(state: FileTabsState, side: number, path: string): FileTabsState {
  return closeTabs(state, side, (p) => p === path);
}

/**
 * Moves a tab to `index` in the row of side `to`: a reorder when `to` is its own side, a move
 * across otherwise. `to` past the last side opens the second one, and there is never a third.
 */
export function moveTab(
  state: FileTabsState,
  from: number,
  path: string,
  to: number,
  index: number,
): FileTabsState {
  const groups = state.groups.map((g) => ({ ...g, tabs: [...g.tabs] }));
  to = Math.min(to, LAST_SIDE);
  if (to >= groups.length) {
    to = groups.length;
    groups.push({ tabs: [], active: null });
  }
  const src = groups[from];
  const i = src ? src.tabs.indexOf(path) : -1;
  if (i < 0) return state;
  if (from !== to && src.active === path) src.active = neighbour(src.tabs, path);
  src.tabs.splice(i, 1);
  if (from === to && index > i) index -= 1;
  const dst = groups[to];
  dst.tabs.splice(Math.min(index, dst.tabs.length), 0, path);
  dst.active = path;
  return settle(groups, to);
}

/** Folds the second side into the first, for a panel that has lost the room to show both. */
export function joinSides(state: FileTabsState): FileTabsState {
  if (state.groups.length < 2) return state;
  const [a, b] = state.groups;
  const active = (state.focus === 1 ? b.active : a.active) ?? a.active ?? b.active;
  return { groups: [{ tabs: [...a.tabs, ...b.tabs], active }], focus: 0 };
}

/** Follows a rename of `from`, a file or a folder, to `to`. */
export function renamePaths(state: FileTabsState, from: string, to: string): FileTabsState {
  const rename = (p: string | null) =>
    p === from ? to : p?.startsWith(`${from}/`) ? to + p.slice(from.length) : p;
  return {
    ...state,
    groups: state.groups.map((g) => ({
      tabs: g.tabs.map((p) => rename(p)!),
      active: rename(g.active),
    })),
  };
}

/** Closes every tab on either side that `remove` picks — a deleted file, or a deleted folder's. */
export function removePaths(
  state: FileTabsState,
  remove: (path: string) => boolean,
): FileTabsState {
  // The second side first, so closing it cannot shift the index of the one still to do.
  let next = state;
  for (let side = state.groups.length - 1; side >= 0; side--) {
    if (side < next.groups.length) next = closeTabs(next, side, remove);
  }
  return next;
}

/** A rectangle on screen; a `DOMRect` is one. */
export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Where the rows of tabs and the files sit on screen, measured while a tab is dragged. */
export interface DropLayout {
  /** `band` is the strip around a row, so the gap after its last tab still counts as the row. */
  rows: { side: number; band: Box; tabs: Box[] }[];
  wells: { side: number; box: Box }[];
}

/** Where a dragged tab would land: a slot in a row of tabs, or a side's whole file. */
export type DropTarget =
  | { kind: "row"; side: number; index: number }
  /** `right` opens the second side; `all` moves the tab onto the other one. */
  | { kind: "well"; side: number; zone: "right" | "all" };

/** What a dragged tab carries: the side it left and its path. */
export interface TabDragData {
  side: number;
  path: string;
}

const inside = (b: Box, x: number, y: number) =>
  x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;

/** Where a tab dragged from `from` would land with the pointer at `x`, `y`. */
export function dropTargetAt(
  state: FileTabsState,
  layout: DropLayout,
  x: number,
  y: number,
  from: TabDragData,
  splitAllowed: boolean,
): DropTarget | null {
  const row = layout.rows.find((r) => inside(r.band, x, y));
  if (row) {
    const after = row.tabs.findIndex((t) => x < (t.left + t.right) / 2);
    return { kind: "row", side: row.side, index: after < 0 ? row.tabs.length : after };
  }
  const well = layout.wells.find((w) => inside(w.box, x, y));
  if (!well) return null;
  if (state.groups.length > 1) {
    return well.side !== from.side ? { kind: "well", side: well.side, zone: "all" } : null;
  }
  const rightHalf = x > (well.box.left + well.box.right) / 2;
  return rightHalf && canSplit(state, from.side, splitAllowed)
    ? { kind: "well", side: well.side, zone: "right" }
    : null;
}

export function dropTab(
  state: FileTabsState,
  target: DropTarget,
  from: TabDragData,
): FileTabsState {
  if (target.kind === "row") return moveTab(state, from.side, from.path, target.side, target.index);
  const to = target.zone === "right" ? LAST_SIDE : target.side;
  return moveTab(state, from.side, from.path, to, Infinity);
}

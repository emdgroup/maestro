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
  const target = Math.min(side ?? state.focus, 1);
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
 * across otherwise. `to` past the last side opens the second one.
 */
export function moveTab(
  state: FileTabsState,
  from: number,
  path: string,
  to: number,
  index: number,
): FileTabsState {
  const groups = state.groups.map((g) => ({ ...g, tabs: [...g.tabs] }));
  if (to >= groups.length) {
    to = groups.length;
    groups.push({ tabs: [], active: null });
  }
  const src = groups[from];
  const i = src.tabs.indexOf(path);
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

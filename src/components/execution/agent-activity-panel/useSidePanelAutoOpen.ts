import { useEffect } from "react";
import type { PendingCanvasAwait } from "../activity/canvas/await-matching";
import type { TabKind } from "@/components/execution/side-panel/useSidePanelTabs";

/** When the session's side panel opens itself, and when a tab in it counts as seen. */
export function useSidePanelAutoOpen({
  isSelected,
  collapsed,
  setCollapsed,
  expandAuto,
  activeTabId,
  unseenTabIds,
  markTabSeen,
  openTabKind,
  pendingCanvasAwaits,
}: {
  isSelected: boolean;
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  expandAuto: () => void;
  activeTabId: string;
  unseenTabIds: ReadonlySet<string>;
  markTabSeen: (tabId: string) => void;
  openTabKind: (kind: TabKind) => void;
  pendingCanvasAwaits: PendingCanvasAwait[];
}) {
  // A visible tab has been seen; a new one only pulls the panel open when there is room.
  useEffect(() => {
    if (!collapsed) markTabSeen(activeTabId);
  }, [collapsed, activeTabId, markTabSeen]);

  useEffect(() => {
    if (unseenTabIds.size > 0) expandAuto();
    // isSelected: a tab that arrived while this session was hidden could not measure
    // the group, so retry once it is on screen.
  }, [unseenTabIds, expandAuto, isSelected]);

  // A canvas the agent is waiting on is a request, not a notification: put it on screen rather
  // than raising an unseen dot on a collapsed panel. Keyed on the newest wait, so a second one
  // arriving re-opens the panel the user closed on the first.
  const awaitedRequestId = pendingCanvasAwaits[pendingCanvasAwaits.length - 1]?.requestId ?? null;
  useEffect(() => {
    if (!awaitedRequestId) return;
    openTabKind("canvas");
    setCollapsed(false);
  }, [awaitedRequestId, openTabKind, setCollapsed]);
}

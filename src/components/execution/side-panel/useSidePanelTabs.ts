import { useState, useEffect, useRef, useCallback } from "react";
import type { CanvasSurface } from "@/components/execution/activity/types";

export type TabKind =
  | "overview"
  | "plan"
  | "subagents"
  | "canvas"
  | "review"
  | "artifacts"
  | "files"
  | "terminal";

export interface SidePanelTab {
  id: string;
  kind: TabKind;
  label: string;
  closeable: boolean;
  initialPath?: string;
  acpTerminalId?: string;
  isAuthTerminal?: boolean;
}

const LABELS: Record<TabKind, string> = {
  overview: "Overview",
  plan: "Plan",
  subagents: "Subagents",
  canvas: "Canvas",
  review: "Review",
  artifacts: "Artifacts",
  files: "Files",
  terminal: "Terminal",
};

function makeTab(kind: TabKind, id?: string): SidePanelTab {
  return {
    id: id ?? kind,
    kind,
    label: LABELS[kind],
    closeable: kind !== "overview" && kind !== "plan",
  };
}

// Singleton kinds use kind as ID — only one instance allowed
const SINGLETONS = new Set<TabKind>([
  "overview",
  "plan",
  "subagents",
  "canvas",
  "review",
  "artifacts",
]);

export interface UseSidePanelTabsResult {
  tabs: SidePanelTab[];
  activeTabId: string;
  setActiveTabId: (id: string) => void;
  closeTab: (id: string) => void;
  addDynamicTab: (kind: "terminal" | "files", initialPath?: string) => string;
  openTabKind: (kind: TabKind) => void;
  openAcpTerminalTab: (terminalId: string, opts?: { isAuthTerminal?: boolean }) => void;
  latestCanvasSurfaceId: string | null;
  /** Tabs opened by the agent that the user has not looked at yet. */
  unseenTabIds: ReadonlySet<string>;
  markTabSeen: (id: string) => void;
}

export function useSidePanelTabs({
  hasPlan,
  canvasMap,
  hasArtifacts,
  changedFilesCount,
}: {
  hasPlan: boolean;
  canvasMap: Map<string, CanvasSurface>;
  hasArtifacts: boolean;
  /** `null` until the diff query settles — see the Review effect below. */
  changedFilesCount: number | null;
}): UseSidePanelTabsResult {
  const [tabs, setTabs] = useState<SidePanelTab[]>([makeTab("overview")]);
  const [activeTabId, setActiveTabId] = useState("overview");
  const [latestCanvasSurfaceId, setLatestCanvasSurfaceId] = useState<string | null>(null);
  const [unseenTabIds, setUnseenTabIds] = useState<ReadonlySet<string>>(() => new Set());
  const counterRef = useRef(0);
  const acpTerminalTabsRef = useRef<Map<string, string>>(new Map());
  const prevPlanRef = useRef(false);
  const prevCanvasSizeRef = useRef(0);
  const prevArtifactsRef = useRef(false);
  const prevChangedCountRef = useRef<number | null>(null);

  const markUnseen = useCallback((id: string) => {
    setUnseenTabIds((prev) => new Set(prev).add(id));
  }, []);

  const markTabSeen = useCallback((id: string) => {
    setUnseenTabIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // Plan: insert at index 1 on arrival, remove on respond
  useEffect(() => {
    const had = prevPlanRef.current;
    prevPlanRef.current = hasPlan;
    if (hasPlan && !had) {
      setTabs((prev) => {
        if (prev.some((t) => t.id === "plan")) return prev;
        const next = [...prev];
        next.splice(1, 0, makeTab("plan"));
        return next;
      });
      setActiveTabId("plan");
      markUnseen("plan");
    } else if (!hasPlan && had) {
      setTabs((prev) => prev.filter((t) => t.id !== "plan"));
      setActiveTabId((prev) => (prev === "plan" ? "overview" : prev));
    }
  }, [hasPlan, markUnseen]);

  // Canvas: auto-insert on first create, update latest surface on new canvas
  useEffect(() => {
    const size = canvasMap.size;
    if (size <= prevCanvasSizeRef.current) {
      prevCanvasSizeRef.current = size;
      return;
    }
    prevCanvasSizeRef.current = size;
    const keys = [...canvasMap.keys()];
    setLatestCanvasSurfaceId(keys[keys.length - 1] ?? null);
    setTabs((prev) => {
      if (prev.some((t) => t.kind === "canvas")) return prev;
      return [...prev, makeTab("canvas")];
    });
    setActiveTabId("canvas");
    markUnseen("canvas");
  }, [canvasMap, markUnseen]);

  // Artifacts: auto-insert once on first artifact (plan takes focus precedence)
  useEffect(() => {
    const had = prevArtifactsRef.current;
    prevArtifactsRef.current = hasArtifacts;
    if (hasArtifacts && !had) {
      setTabs((prev) => {
        if (prev.some((t) => t.kind === "artifacts")) return prev;
        return [...prev, makeTab("artifacts")];
      });
      setActiveTabId((prev) => (prev === "plan" ? prev : "artifacts"));
      markUnseen("artifacts");
    }
  }, [hasArtifacts, markUnseen]);

  // Review: open on the first change of the session, then only re-flag as unseen.
  //
  // The first settled count is a baseline, not a change — a resumed session usually has a
  // diff already and must not yank the panel to Review on mount. Later increases do not
  // steal focus either: unlike a canvas surface they arrive every few seconds while the
  // agent edits, and a tab that keeps grabbing focus mid-run is unusable. A Review tab the
  // user has closed stays closed.
  useEffect(() => {
    if (changedFilesCount === null) return;
    const prev = prevChangedCountRef.current;
    prevChangedCountRef.current = changedFilesCount;
    if (prev === null || changedFilesCount <= prev) return;
    if (prev === 0) {
      setTabs((tabsPrev) => {
        if (tabsPrev.some((t) => t.kind === "review")) return tabsPrev;
        return [...tabsPrev, makeTab("review")];
      });
      setActiveTabId("review");
      markUnseen("review");
    } else if (tabs.some((t) => t.kind === "review")) {
      markUnseen("review");
    }
    // `tabs` re-runs this harmlessly: the count is unchanged by then, so it returns early.
  }, [changedFilesCount, markUnseen, tabs]);

  const closeTab = useCallback(
    (id: string) => {
      markTabSeen(id);
      setTabs((prev) => {
        const tab = prev.find((t) => t.id === id);
        if (tab?.acpTerminalId) {
          acpTerminalTabsRef.current.delete(tab.acpTerminalId);
        }
        return prev.filter((t) => t.id !== id);
      });
      setActiveTabId((prev) => (prev === id ? "overview" : prev));
    },
    [markTabSeen],
  );

  const addDynamicTab = useCallback((kind: "terminal" | "files", initialPath?: string): string => {
    counterRef.current += 1;
    const id = `${kind}-${counterRef.current}`;
    setTabs((prev) => [...prev, { ...makeTab(kind, id), initialPath }]);
    setActiveTabId(id);
    return id;
  }, []);

  const openAcpTerminalTab = useCallback(
    (terminalId: string, opts?: { isAuthTerminal?: boolean }) => {
      const existingId = acpTerminalTabsRef.current.get(terminalId);
      if (existingId) {
        setActiveTabId(existingId);
        return;
      }
      counterRef.current += 1;
      const id = `terminal-${counterRef.current}`;
      acpTerminalTabsRef.current.set(terminalId, id);
      setTabs((prev) => [
        ...prev,
        {
          ...makeTab("terminal", id),
          acpTerminalId: terminalId,
          isAuthTerminal: opts?.isAuthTerminal,
        },
      ]);
      setActiveTabId(id);
      markUnseen(id);
    },
    [markUnseen],
  );

  const openTabKind = useCallback(
    (kind: TabKind) => {
      if (SINGLETONS.has(kind)) {
        setTabs((prev) => {
          if (prev.some((t) => t.id === kind)) return prev;
          return [...prev, makeTab(kind)];
        });
        setActiveTabId(kind);
      } else {
        addDynamicTab(kind as "terminal" | "files");
      }
    },
    [addDynamicTab],
  );

  return {
    tabs,
    activeTabId,
    setActiveTabId,
    closeTab,
    addDynamicTab,
    openTabKind,
    openAcpTerminalTab,
    latestCanvasSurfaceId,
    unseenTabIds,
    markTabSeen,
  };
}

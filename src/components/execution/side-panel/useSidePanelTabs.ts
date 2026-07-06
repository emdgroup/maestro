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
  latestCanvasSurfaceId: string | null;
}

export function useSidePanelTabs({
  hasPlan,
  canvasMap,
  hasArtifacts,
}: {
  hasPlan: boolean;
  canvasMap: Map<string, CanvasSurface>;
  hasArtifacts: boolean;
}): UseSidePanelTabsResult {
  const [tabs, setTabs] = useState<SidePanelTab[]>([makeTab("overview")]);
  const [activeTabId, setActiveTabId] = useState("overview");
  const [latestCanvasSurfaceId, setLatestCanvasSurfaceId] = useState<string | null>(null);
  const counterRef = useRef(0);
  const prevPlanRef = useRef(false);
  const prevCanvasSizeRef = useRef(0);
  const prevArtifactsRef = useRef(false);

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
    } else if (!hasPlan && had) {
      setTabs((prev) => prev.filter((t) => t.id !== "plan"));
      setActiveTabId((prev) => (prev === "plan" ? "overview" : prev));
    }
  }, [hasPlan]);

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
  }, [canvasMap]);

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
    }
  }, [hasArtifacts]);

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => prev.filter((t) => t.id !== id));
    setActiveTabId((prev) => (prev === id ? "overview" : prev));
  }, []);

  const addDynamicTab = useCallback((kind: "terminal" | "files", initialPath?: string): string => {
    counterRef.current += 1;
    const id = `${kind}-${counterRef.current}`;
    setTabs((prev) => [...prev, { ...makeTab(kind, id), initialPath }]);
    setActiveTabId(id);
    return id;
  }, []);

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
    latestCanvasSurfaceId,
  };
}

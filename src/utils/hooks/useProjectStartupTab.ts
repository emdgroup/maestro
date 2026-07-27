import { useEffect, useRef } from "react";
import type { ViewType } from "@/store/navigationStore";

const VALID_STARTUP_TABS: readonly string[] = ["kanban", "agents", "worktrees", "settings"];

interface StartupTabTransition {
  appliedForProjectId: number | null;
  tab: ViewType | null;
}

export function resolveProjectStartupTab(
  projectId: number | null,
  startupTab: string | null | undefined,
  appliedForProjectId: number | null,
): StartupTabTransition {
  if (projectId == null) return { appliedForProjectId: null, tab: null };
  if (!startupTab || appliedForProjectId === projectId) {
    return { appliedForProjectId, tab: null };
  }

  return {
    appliedForProjectId: projectId,
    tab: VALID_STARTUP_TABS.includes(startupTab) ? (startupTab as ViewType) : null,
  };
}

export function useProjectStartupTab(
  projectId: number | null,
  startupTab: string | null | undefined,
  setActiveTab: (tab: ViewType) => void,
) {
  const appliedForProjectRef = useRef<number | null>(null);

  useEffect(() => {
    const transition = resolveProjectStartupTab(
      projectId,
      startupTab,
      appliedForProjectRef.current,
    );
    appliedForProjectRef.current = transition.appliedForProjectId;
    if (transition.tab) setActiveTab(transition.tab);
  }, [projectId, startupTab, setActiveTab]);
}

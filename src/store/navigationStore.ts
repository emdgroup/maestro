import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { useShallow } from "zustand/shallow";

export type ViewType = "kanban" | "agents" | "worktrees" | "settings";
export type NavigationTarget =
  | { taskId: number }
  | { agentId: string }
  | { worktreeId: string }
  | { view: "tasks" | "agents" | "worktree" | "settings" };

const PAGE_ORDER: Record<ViewType, number> = {
  kanban: 0,
  agents: 1,
  worktrees: 2,
  settings: 3,
};

function targetViewToTab(view: string): ViewType {
  if (view === "worktree") return "worktrees";
  if (view === "tasks") return "kanban";
  return view as ViewType;
}

interface NavigationState {
  activeTab: ViewType;
  slideDirection: number;
  activeTaskId: number | null;
  pendingAgentId: string | null;
  pendingWorktreeId: string | null;

  navigate: (target: NavigationTarget) => void;
  setActiveTab: (tab: ViewType) => void;
  setActiveTaskId: (id: number | null) => void;
  clearPendingAgent: () => void;
  clearPendingWorktree: () => void;
}

export const useNavigationStore = create<NavigationState>()(
  immer((set) => ({
    activeTab: "kanban",
    slideDirection: 1,
    activeTaskId: null,
    pendingAgentId: null,
    pendingWorktreeId: null,

    navigate: (target: NavigationTarget) =>
      set((state) => {
        if ("taskId" in target) {
          const newTab: ViewType = "kanban";
          state.slideDirection = PAGE_ORDER[newTab] > PAGE_ORDER[state.activeTab] ? 1 : -1;
          state.activeTab = newTab;
          state.activeTaskId = target.taskId;
        } else if ("agentId" in target) {
          const newTab: ViewType = "agents";
          state.slideDirection = PAGE_ORDER[newTab] > PAGE_ORDER[state.activeTab] ? 1 : -1;
          state.activeTab = newTab;
          state.pendingAgentId = target.agentId;
        } else if ("worktreeId" in target) {
          const newTab: ViewType = "worktrees";
          state.slideDirection = PAGE_ORDER[newTab] > PAGE_ORDER[state.activeTab] ? 1 : -1;
          state.activeTab = newTab;
          state.pendingWorktreeId = target.worktreeId;
        } else if ("view" in target) {
          const newTab = targetViewToTab(target.view);
          state.slideDirection = PAGE_ORDER[newTab] > PAGE_ORDER[state.activeTab] ? 1 : -1;
          state.activeTab = newTab;
          if (target.view === "tasks") {
            state.activeTaskId = null;
          }
        }
      }),

    setActiveTab: (tab: ViewType) =>
      set((state) => {
        if (tab !== state.activeTab) {
          state.slideDirection = PAGE_ORDER[tab] > PAGE_ORDER[state.activeTab] ? 1 : -1;
          state.activeTab = tab;
        }
      }),

    setActiveTaskId: (id: number | null) =>
      set((state) => {
        state.activeTaskId = id;
      }),

    clearPendingAgent: () =>
      set((state) => {
        state.pendingAgentId = null;
      }),

    clearPendingWorktree: () =>
      set((state) => {
        state.pendingWorktreeId = null;
      }),
  })),
);

// Selector hooks
export const useActiveTab = () => useNavigationStore((s) => s.activeTab);
export const useSlideDirection = () => useNavigationStore((s) => s.slideDirection);
export const useActiveTaskId = () => useNavigationStore((s) => s.activeTaskId);
export const usePendingAgentId = () => useNavigationStore((s) => s.pendingAgentId);
export const usePendingWorktreeId = () => useNavigationStore((s) => s.pendingWorktreeId);
export const useNavigate = () => useNavigationStore((s) => s.navigate);
export const useNavigationActions = () =>
  useNavigationStore(
    useShallow((s) => ({
      setActiveTab: s.setActiveTab,
      setActiveTaskId: s.setActiveTaskId,
      clearPendingAgent: s.clearPendingAgent,
      clearPendingWorktree: s.clearPendingWorktree,
    })),
  );

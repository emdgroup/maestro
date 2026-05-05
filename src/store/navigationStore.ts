import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { useShallow } from "zustand/react/shallow";

export type ViewType = "kanban" | "agents" | "worktrees" | "settings";
export type SubView = "backlog" | "board" | "archive";
export type NavigationTarget =
  | { taskId: string }
  | { agentId: string }
  | { worktreeId: string }
  | { view: "backlog" | "board" | "archive" | "agents" | "worktree" | "settings" };

const PAGE_ORDER: Record<ViewType, number> = {
  kanban: 0,
  agents: 1,
  worktrees: 2,
  settings: 3,
};

function targetViewToTab(view: string): ViewType {
  if (view === "worktree") return "worktrees";
  if (view === "backlog" || view === "board" || view === "archive") return "kanban";
  return view as ViewType;
}

interface NavigationState {
  activeTab: ViewType;
  slideDirection: number;
  activeSubView: SubView;
  pendingTaskId: string | null;
  pendingAgentId: string | null;
  pendingWorktreeId: string | null;

  navigate: (target: NavigationTarget) => void;
  setActiveTab: (tab: ViewType) => void;
  setActiveSubView: (sub: SubView) => void;
  clearPendingTask: () => void;
  clearPendingAgent: () => void;
  clearPendingWorktree: () => void;
}

export const useNavigationStore = create<NavigationState>()(
  immer((set) => ({
    activeTab: "kanban",
    slideDirection: 1,
    activeSubView: "board",
    pendingTaskId: null,
    pendingAgentId: null,
    pendingWorktreeId: null,

    navigate: (target: NavigationTarget) =>
      set((state) => {
        if ("taskId" in target) {
          const newTab: ViewType = "kanban";
          state.slideDirection = PAGE_ORDER[newTab] > PAGE_ORDER[state.activeTab] ? 1 : -1;
          state.activeTab = newTab;
          state.activeSubView = "board";
          state.pendingTaskId = target.taskId;
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
          if (target.view === "backlog" || target.view === "board" || target.view === "archive") {
            state.activeSubView = target.view;
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

    setActiveSubView: (sub: SubView) =>
      set((state) => {
        state.activeSubView = sub;
      }),

    clearPendingTask: () =>
      set((state) => {
        state.pendingTaskId = null;
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
export const useActiveSubView = () => useNavigationStore((s) => s.activeSubView);
export const usePendingTaskId = () => useNavigationStore((s) => s.pendingTaskId);
export const usePendingAgentId = () => useNavigationStore((s) => s.pendingAgentId);
export const usePendingWorktreeId = () => useNavigationStore((s) => s.pendingWorktreeId);
export const useNavigate = () => useNavigationStore((s) => s.navigate);
export const useNavigationActions = () =>
  useNavigationStore(
    useShallow((s) => ({
      setActiveTab: s.setActiveTab,
      setActiveSubView: s.setActiveSubView,
      clearPendingTask: s.clearPendingTask,
      clearPendingAgent: s.clearPendingAgent,
      clearPendingWorktree: s.clearPendingWorktree,
    })),
  );

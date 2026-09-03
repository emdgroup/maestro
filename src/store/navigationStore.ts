import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { useShallow } from "zustand/shallow";

export type ViewType = "kanban" | "agents" | "worktrees" | "settings";
export type NavigationTarget =
  | { taskId: number }
  | { agentId: string }
  | { sessionKey: number }
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
  /**
   * A specific session to focus, where `pendingAgentId` names a *task* and lands on whichever of
   * its sessions comes first. A worktree can hold several sessions and a session need not belong
   * to a task at all, so neither is reachable through the task-keyed route.
   */
  pendingSessionKey: number | null;
  pendingWorktreeId: string | null;
  /**
   * A page in the settings sidebar to open on arrival, by its id in `settings-registry`.
   *
   * `SettingsPage` owns which page is showing, so without this nothing outside it can say "open
   * Agents" — a message telling the user where to go could not take them there.
   */
  pendingSettingsPage: string | null;

  navigate: (target: NavigationTarget) => void;
  setActiveTab: (tab: ViewType) => void;
  setActiveTaskId: (id: number | null) => void;
  setPendingSettingsPage: (pageId: string) => void;
  clearPendingAgent: () => void;
  clearPendingSession: () => void;
  clearPendingWorktree: () => void;
  clearPendingSettingsPage: () => void;
}

export const useNavigationStore = create<NavigationState>()(
  immer((set) => ({
    activeTab: "kanban",
    slideDirection: 1,
    activeTaskId: null,
    pendingAgentId: null,
    pendingSessionKey: null,
    pendingWorktreeId: null,
    pendingSettingsPage: null,

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
        } else if ("sessionKey" in target) {
          const newTab: ViewType = "agents";
          state.slideDirection = PAGE_ORDER[newTab] > PAGE_ORDER[state.activeTab] ? 1 : -1;
          state.activeTab = newTab;
          state.pendingSessionKey = target.sessionKey;
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

    setPendingSettingsPage: (pageId: string) =>
      set((state) => {
        state.pendingSettingsPage = pageId;
      }),

    clearPendingAgent: () =>
      set((state) => {
        state.pendingAgentId = null;
      }),

    clearPendingSession: () =>
      set((state) => {
        state.pendingSessionKey = null;
      }),

    clearPendingWorktree: () =>
      set((state) => {
        state.pendingWorktreeId = null;
      }),

    clearPendingSettingsPage: () =>
      set((state) => {
        state.pendingSettingsPage = null;
      }),
  })),
);

// Selector hooks
export const useActiveTab = () => useNavigationStore((s) => s.activeTab);
export const useSlideDirection = () => useNavigationStore((s) => s.slideDirection);
export const useActiveTaskId = () => useNavigationStore((s) => s.activeTaskId);
export const usePendingAgentId = () => useNavigationStore((s) => s.pendingAgentId);
export const usePendingSessionKey = () => useNavigationStore((s) => s.pendingSessionKey);
export const usePendingWorktreeId = () => useNavigationStore((s) => s.pendingWorktreeId);
export const usePendingSettingsPage = () => useNavigationStore((s) => s.pendingSettingsPage);
export const useNavigate = () => useNavigationStore((s) => s.navigate);
export const useNavigationActions = () =>
  useNavigationStore(
    useShallow((s) => ({
      setActiveTab: s.setActiveTab,
      setActiveTaskId: s.setActiveTaskId,
      setPendingSettingsPage: s.setPendingSettingsPage,
      clearPendingAgent: s.clearPendingAgent,
      clearPendingSession: s.clearPendingSession,
      clearPendingWorktree: s.clearPendingWorktree,
      clearPendingSettingsPage: s.clearPendingSettingsPage,
    })),
  );

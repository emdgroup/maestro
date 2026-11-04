import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { useShallow } from "zustand/shallow";

export type ViewType = "kanban" | "agents" | "worktrees" | "collections";
export type NavigationTarget =
  | { taskId: number }
  | { agentId: string }
  | { sessionId: string }
  | { worktreeId: string }
  | { view: "tasks" | "agents" | "worktree" | "collections" | "settings" };

const PAGE_ORDER: Record<ViewType, number> = {
  kanban: 0,
  agents: 1,
  collections: 2,
  worktrees: 3,
};

function targetViewToTab(view: string): ViewType {
  if (view === "worktree") return "worktrees";
  if (view === "tasks") return "kanban";
  return view as ViewType;
}

/**
 * Switches to `tab`, sliding right to a page further along and left to one before it. Switching to
 * the tab already showing leaves the direction alone, since nothing slides.
 */
function slideTo(state: Pick<NavigationState, "activeTab" | "slideDirection">, tab: ViewType) {
  if (tab === state.activeTab) return;
  state.slideDirection = PAGE_ORDER[tab] > PAGE_ORDER[state.activeTab] ? 1 : -1;
  state.activeTab = tab;
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
  pendingSessionId: string | null;
  pendingWorktreeId: string | null;
  /**
   * A page in the settings sidebar to open on arrival, by its id in `settings-registry`.
   *
   * `SettingsPage` owns which page is showing, so without this nothing outside it can say "open
   * Agents" — a message telling the user where to go could not take them there.
   */
  pendingSettingsPage: string | null;
  /**
   * Settings is a dialog, not a tab, so it is state beside `activeTab` rather than one of its
   * values. Opening it therefore leaves the user on the view they were already on.
   */
  settingsOpen: boolean;

  navigate: (target: NavigationTarget) => void;
  setActiveTab: (tab: ViewType) => void;
  setActiveTaskId: (id: number | null) => void;
  openSettings: (pageId?: string) => void;
  setSettingsOpen: (open: boolean) => void;
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
    pendingSessionId: null,
    pendingWorktreeId: null,
    pendingSettingsPage: null,
    settingsOpen: false,

    navigate: (target: NavigationTarget) =>
      set((state) => {
        if ("taskId" in target) {
          slideTo(state, "kanban");
          state.activeTaskId = target.taskId;
        } else if ("agentId" in target) {
          slideTo(state, "agents");
          state.pendingAgentId = target.agentId;
        } else if ("sessionId" in target) {
          slideTo(state, "agents");
          state.pendingSessionId = target.sessionId;
        } else if ("worktreeId" in target) {
          slideTo(state, "worktrees");
          state.pendingWorktreeId = target.worktreeId;
        } else if ("view" in target) {
          // Settings no longer has a tab to slide to, so it opens over whatever is showing.
          if (target.view === "settings") {
            state.settingsOpen = true;
            return;
          }
          slideTo(state, targetViewToTab(target.view));
          if (target.view === "tasks") {
            state.activeTaskId = null;
          }
        }
      }),

    setActiveTab: (tab: ViewType) =>
      set((state) => {
        slideTo(state, tab);
      }),

    setActiveTaskId: (id: number | null) =>
      set((state) => {
        state.activeTaskId = id;
      }),

    openSettings: (pageId?: string) =>
      set((state) => {
        state.settingsOpen = true;
        if (pageId) state.pendingSettingsPage = pageId;
      }),

    setSettingsOpen: (open: boolean) =>
      set((state) => {
        state.settingsOpen = open;
      }),

    clearPendingAgent: () =>
      set((state) => {
        state.pendingAgentId = null;
      }),

    clearPendingSession: () =>
      set((state) => {
        state.pendingSessionId = null;
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
export const usePendingSessionKey = () => useNavigationStore((s) => s.pendingSessionId);
export const usePendingWorktreeId = () => useNavigationStore((s) => s.pendingWorktreeId);
export const usePendingSettingsPage = () => useNavigationStore((s) => s.pendingSettingsPage);
export const useSettingsOpen = () => useNavigationStore((s) => s.settingsOpen);
export const useNavigate = () => useNavigationStore((s) => s.navigate);
export const useNavigationActions = () =>
  useNavigationStore(
    useShallow((s) => ({
      setActiveTab: s.setActiveTab,
      setActiveTaskId: s.setActiveTaskId,
      openSettings: s.openSettings,
      setSettingsOpen: s.setSettingsOpen,
      clearPendingAgent: s.clearPendingAgent,
      clearPendingSession: s.clearPendingSession,
      clearPendingWorktree: s.clearPendingWorktree,
      clearPendingSettingsPage: s.clearPendingSettingsPage,
    })),
  );

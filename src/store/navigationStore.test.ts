import { beforeEach, describe, expect, it } from "vitest";
import { useNavigationStore } from "./navigationStore";

// Reset store state before each test
function resetStore() {
  useNavigationStore.setState({
    activeTab: "kanban",
    slideDirection: 1,
    activeTaskId: null,
    pendingAgentId: null,
    pendingSessionId: null,
    pendingWorktreeId: null,
    pendingSettingsPage: null,
    settingsOpen: false,
  });
}

describe("navigationStore – navigate() with entity targets", () => {
  beforeEach(resetStore);

  it("navigate({ agentId }) sets activeTab=agents, pendingAgentId", () => {
    const { navigate } = useNavigationStore.getState();
    navigate({ agentId: "7" });
    const state = useNavigationStore.getState();
    expect(state.activeTab).toBe("agents");
    expect(state.pendingAgentId).toBe("7");
  });

  /**
   * `agentId` names a *task* and lands on whichever of its sessions comes first. A worktree can
   * hold several sessions, and a session need not belong to a task at all, so neither is reachable
   * through that route.
   */
  it("navigate({ sessionId }) sets activeTab=agents, pendingSessionId", () => {
    const { navigate } = useNavigationStore.getState();
    navigate({ sessionId: "12" });
    const state = useNavigationStore.getState();
    expect(state.activeTab).toBe("agents");
    expect(state.pendingSessionId).toBe("12");
    expect(state.pendingAgentId).toBeNull();
  });

  it("navigate({ worktreeId }) sets activeTab=worktrees, pendingWorktreeId", () => {
    const { navigate } = useNavigationStore.getState();
    navigate({ worktreeId: "3" });
    const state = useNavigationStore.getState();
    expect(state.activeTab).toBe("worktrees");
    expect(state.pendingWorktreeId).toBe("3");
  });
});

describe("navigationStore – navigate() with view targets", () => {
  beforeEach(resetStore);

  it("navigate({ view: 'agents' }) sets activeTab=agents", () => {
    const { navigate } = useNavigationStore.getState();
    navigate({ view: "agents" });
    const state = useNavigationStore.getState();
    expect(state.activeTab).toBe("agents");
  });

  it("navigate({ view: 'worktree' }) maps singular to plural: activeTab=worktrees", () => {
    const { navigate } = useNavigationStore.getState();
    navigate({ view: "worktree" });
    const state = useNavigationStore.getState();
    expect(state.activeTab).toBe("worktrees");
  });

  it("navigate({ view: 'collections' }) sets activeTab=collections", () => {
    const { navigate } = useNavigationStore.getState();
    navigate({ view: "collections" });
    const state = useNavigationStore.getState();
    expect(state.activeTab).toBe("collections");
  });

  // Settings is a dialog, so navigating to it opens the dialog and leaves the tab alone — the
  // whole reason it moved out of the tab row.
  it("navigate({ view: 'settings' }) opens the dialog without changing the tab", () => {
    const { setActiveTab, navigate } = useNavigationStore.getState();
    setActiveTab("agents");
    navigate({ view: "settings" });
    const state = useNavigationStore.getState();
    expect(state.settingsOpen).toBe(true);
    expect(state.activeTab).toBe("agents");
  });

  it("openSettings(pageId) opens the dialog on that page", () => {
    const { openSettings } = useNavigationStore.getState();
    openSettings("agents");
    const state = useNavigationStore.getState();
    expect(state.settingsOpen).toBe(true);
    expect(state.pendingSettingsPage).toBe("agents");
  });
});

describe("navigationStore – slideDirection", () => {
  beforeEach(resetStore);

  it("forward navigation (kanban->agents) sets slideDirection=1", () => {
    const { setActiveTab } = useNavigationStore.getState();
    setActiveTab("agents");
    expect(useNavigationStore.getState().slideDirection).toBe(1);
  });

  it("backward navigation (collections->kanban) sets slideDirection=-1", () => {
    useNavigationStore.setState({ activeTab: "collections" });
    const { setActiveTab } = useNavigationStore.getState();
    setActiveTab("kanban");
    expect(useNavigationStore.getState().slideDirection).toBe(-1);
  });

  it("same-tab navigation does NOT update slideDirection", () => {
    useNavigationStore.setState({ activeTab: "kanban", slideDirection: -1 });
    const { setActiveTab } = useNavigationStore.getState();
    setActiveTab("kanban");
    expect(useNavigationStore.getState().slideDirection).toBe(-1);
  });
});

describe("navigationStore – activeTaskId", () => {
  beforeEach(resetStore);

  it("navigate({ taskId: 42 }) sets activeTaskId to 42 and activeTab to kanban", () => {
    const { navigate } = useNavigationStore.getState();
    navigate({ taskId: 42 });
    const state = useNavigationStore.getState();
    expect(state.activeTaskId).toBe(42);
    expect(state.activeTab).toBe("kanban");
  });

  it("navigate({ view: 'tasks' }) clears activeTaskId to null", () => {
    useNavigationStore.setState({ activeTaskId: 42 });
    const { navigate } = useNavigationStore.getState();
    navigate({ view: "tasks" });
    const state = useNavigationStore.getState();
    expect(state.activeTaskId).toBeNull();
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { useNavigationStore } from "./navigationStore";

// Reset store state before each test
function resetStore() {
  useNavigationStore.setState({
    activeTab: "kanban",
    slideDirection: 1,
    activeSubView: "board",
    pendingTaskId: null,
    pendingAgentId: null,
    pendingWorktreeId: null,
  });
}

describe("navigationStore – initial state", () => {
  beforeEach(resetStore);

  it("has correct initial state", () => {
    const state = useNavigationStore.getState();
    expect(state.activeTab).toBe("kanban");
    expect(state.slideDirection).toBe(1);
    expect(state.activeSubView).toBe("board");
    expect(state.pendingTaskId).toBeNull();
    expect(state.pendingAgentId).toBeNull();
    expect(state.pendingWorktreeId).toBeNull();
  });
});

describe("navigationStore – navigate() with entity targets", () => {
  beforeEach(resetStore);

  it("navigate({ taskId }) sets activeTab=kanban, activeSubView=board, pendingTaskId", () => {
    const { navigate } = useNavigationStore.getState();
    navigate({ taskId: "42" });
    const state = useNavigationStore.getState();
    expect(state.activeTab).toBe("kanban");
    expect(state.activeSubView).toBe("board");
    expect(state.pendingTaskId).toBe("42");
  });

  it("navigate({ agentId }) sets activeTab=agents, pendingAgentId", () => {
    const { navigate } = useNavigationStore.getState();
    navigate({ agentId: "7" });
    const state = useNavigationStore.getState();
    expect(state.activeTab).toBe("agents");
    expect(state.pendingAgentId).toBe("7");
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

  it("navigate({ view: 'board' }) sets activeTab=kanban, activeSubView=board", () => {
    const { navigate } = useNavigationStore.getState();
    navigate({ view: "board" });
    const state = useNavigationStore.getState();
    expect(state.activeTab).toBe("kanban");
    expect(state.activeSubView).toBe("board");
  });

  it("navigate({ view: 'backlog' }) sets activeTab=kanban, activeSubView=backlog", () => {
    const { navigate } = useNavigationStore.getState();
    navigate({ view: "backlog" });
    const state = useNavigationStore.getState();
    expect(state.activeTab).toBe("kanban");
    expect(state.activeSubView).toBe("backlog");
  });

  it("navigate({ view: 'archive' }) sets activeTab=kanban, activeSubView=archive", () => {
    const { navigate } = useNavigationStore.getState();
    navigate({ view: "archive" });
    const state = useNavigationStore.getState();
    expect(state.activeTab).toBe("kanban");
    expect(state.activeSubView).toBe("archive");
  });

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

  it("navigate({ view: 'settings' }) sets activeTab=settings", () => {
    const { navigate } = useNavigationStore.getState();
    navigate({ view: "settings" });
    const state = useNavigationStore.getState();
    expect(state.activeTab).toBe("settings");
  });
});

describe("navigationStore – slideDirection", () => {
  beforeEach(resetStore);

  it("forward navigation (kanban->agents) sets slideDirection=1", () => {
    const { setActiveTab } = useNavigationStore.getState();
    setActiveTab("agents");
    expect(useNavigationStore.getState().slideDirection).toBe(1);
  });

  it("backward navigation (settings->kanban) sets slideDirection=-1", () => {
    useNavigationStore.setState({ activeTab: "settings" });
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

describe("navigationStore – clear actions", () => {
  beforeEach(resetStore);

  it("clearPendingTask sets pendingTaskId to null", () => {
    useNavigationStore.setState({ pendingTaskId: "99" });
    useNavigationStore.getState().clearPendingTask();
    expect(useNavigationStore.getState().pendingTaskId).toBeNull();
  });

  it("clearPendingAgent sets pendingAgentId to null", () => {
    useNavigationStore.setState({ pendingAgentId: "55" });
    useNavigationStore.getState().clearPendingAgent();
    expect(useNavigationStore.getState().pendingAgentId).toBeNull();
  });

  it("clearPendingWorktree sets pendingWorktreeId to null", () => {
    useNavigationStore.setState({ pendingWorktreeId: "11" });
    useNavigationStore.getState().clearPendingWorktree();
    expect(useNavigationStore.getState().pendingWorktreeId).toBeNull();
  });
});

describe("navigationStore – setActiveSubView", () => {
  beforeEach(resetStore);

  it("setActiveSubView('archive') sets activeSubView to archive", () => {
    useNavigationStore.getState().setActiveSubView("archive");
    expect(useNavigationStore.getState().activeSubView).toBe("archive");
  });
});

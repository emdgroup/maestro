import { beforeEach, describe, expect, it } from "vitest";
import { useNavigationStore } from "./navigationStore";

// Reset store state before each test
function resetStore() {
  useNavigationStore.setState({
    activeTab: "kanban",
    slideDirection: 1,
    activeTaskId: null,
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
    expect(state.activeTaskId).toBeNull();
    expect(state.pendingAgentId).toBeNull();
    expect(state.pendingWorktreeId).toBeNull();
  });
});

describe("navigationStore – navigate() with entity targets", () => {
  beforeEach(resetStore);

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

  it("setActiveTaskId(7) sets activeTaskId to 7", () => {
    useNavigationStore.getState().setActiveTaskId(7);
    expect(useNavigationStore.getState().activeTaskId).toBe(7);
  });

  it("setActiveTaskId(null) clears activeTaskId to null", () => {
    useNavigationStore.setState({ activeTaskId: 7 });
    useNavigationStore.getState().setActiveTaskId(null);
    expect(useNavigationStore.getState().activeTaskId).toBeNull();
  });
});

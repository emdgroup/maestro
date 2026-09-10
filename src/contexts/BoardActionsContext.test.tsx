import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ActiveSessionInfo, WorktreeWithStatus } from "@/types/bindings";

const profiles = vi.hoisted(() => ({ current: [] as Array<{ id: string; role: string }> }));
const defaultAgent = vi.hoisted(() => ({ current: null as string | null }));
const sessions = vi.hoisted(() => ({ current: [] as ActiveSessionInfo[] }));
const worktrees = vi.hoisted(() => ({ current: [] as WorktreeWithStatus[] }));

vi.mock("@/contexts/KanbanContext", () => ({
  useKanban: () => ({ projectId: 1, projectPath: "/tmp/demo", connection: { type: "local" } }),
}));

vi.mock("@/hooks/useExecuteTask", () => ({
  useExecuteTask: () => ({
    execute: vi.fn(),
    executingTaskId: null,
    isExecuting: false,
    dirtyDialogOpen: false,
    dirtyModifiedCount: 0,
    dirtyUntrackedCount: 0,
    onDirtyChoice: vi.fn(),
    onDirtyCancel: vi.fn(),
    agentPickerTask: null,
    onAgentPicked: vi.fn(),
    onAgentPickerCancel: vi.fn(),
  }),
}));

vi.mock("@/services/execution.service", () => ({
  useActiveSessionsQuery: () => ({ data: sessions.current }),
}));

vi.mock("@/services/worktree.service", () => ({
  useWorktreesQuery: () => ({ data: worktrees.current }),
}));

vi.mock("@/services/project.service", () => ({
  useAgentProfilesQuery: () => ({ data: { profiles: profiles.current, defaults: {} } }),
  useProjectSettings: () => ({ data: { default_agent: defaultAgent.current } }),
}));

vi.mock("@/components/execution/DirtyWorktreeDialog", () => ({
  DirtyWorktreeDialog: () => null,
}));

vi.mock("@/components/execution/AgentPickerModal", () => ({
  AgentPickerModal: () => null,
}));

import {
  BoardActionsProvider,
  useBoardActionsContext,
  useTaskSession,
  useTaskWorktree,
} from "./BoardActionsContext";

const wrapper = ({ children }: { children: ReactNode }) => (
  <BoardActionsProvider>{children}</BoardActionsProvider>
);

function session(taskId: number | null, key: number): ActiveSessionInfo {
  return { session_key: key, task_id: taskId } as ActiveSessionInfo;
}

function worktree(taskId: number | null, id: number): WorktreeWithStatus {
  return { id, task_id: taskId, path: `/tmp/wt/${id}` } as WorktreeWithStatus;
}

beforeEach(() => {
  profiles.current = [];
  defaultAgent.current = null;
  sessions.current = [];
  worktrees.current = [];
});

/**
 * These two rules decided whether a card could offer Refine, and were recomputed identically in
 * every card on the board before they moved here. They are a property of the project.
 */
describe("canRefine", () => {
  it("is true when a role has a Refiner profile", () => {
    profiles.current = [{ id: "refiner-1", role: "Refiner" }];

    const { result } = renderHook(() => useBoardActionsContext(), { wrapper });

    expect(result.current.canRefine).toBe(true);
  });

  /**
   * A project that predates profiles configures one agent and expects everything to use it, so
   * gating purely on the Refiner profile would take Refine away from it.
   */
  it("is true with no Refiner profile but a project default agent", () => {
    defaultAgent.current = "claude-acp";

    const { result } = renderHook(() => useBoardActionsContext(), { wrapper });

    expect(result.current.canRefine).toBe(true);
  });

  it("is false when the project has configured neither", () => {
    const { result } = renderHook(() => useBoardActionsContext(), { wrapper });

    expect(result.current.canRefine).toBe(false);
  });

  /**
   * Another role's profile is not a refiner. The check used to be `.some(...)` over every profile
   * in the document, so this pins that it reads the role.
   */
  it("is false when only other roles have profiles", () => {
    profiles.current = [{ id: "coder-1", role: "Coder" }];

    const { result } = renderHook(() => useBoardActionsContext(), { wrapper });

    expect(result.current.canRefine).toBe(false);
  });
});

describe("useTaskSession", () => {
  it("finds the session belonging to a task", () => {
    sessions.current = [session(4, 100), session(7, 101)];

    const { result } = renderHook(() => useTaskSession(7), { wrapper });

    expect(result.current?.session_key).toBe(101);
  });

  it("gives null for a task with no live session", () => {
    sessions.current = [session(4, 100)];

    const { result } = renderHook(() => useTaskSession(7), { wrapper });

    expect(result.current).toBeNull();
  });

  /**
   * A session belonging to no task — one the user started from the Agents view — must not be
   * indexed under a task id at all, or it would surface on whichever card shares its key.
   */
  it("ignores sessions that belong to no task", () => {
    sessions.current = [session(null, 100)];

    const { result } = renderHook(() => useBoardActionsContext(), { wrapper });

    expect(result.current.sessionByTaskId.size).toBe(0);
  });
});

describe("useTaskWorktree", () => {
  it("finds the worktree a task left behind", () => {
    worktrees.current = [worktree(4, 1), worktree(7, 2)];

    const { result } = renderHook(() => useTaskWorktree(7), { wrapper });

    expect(result.current?.id).toBe(2);
  });

  it("gives null for a task with no worktree", () => {
    const { result } = renderHook(() => useTaskWorktree(7), { wrapper });

    expect(result.current).toBeNull();
  });

  it("ignores worktrees that belong to no task", () => {
    worktrees.current = [worktree(null, 1)];

    const { result } = renderHook(() => useBoardActionsContext(), { wrapper });

    expect(result.current.worktreeByTaskId.size).toBe(0);
  });
});

/**
 * The card compares its own id rather than reading a boolean, because one instance of
 * `useExecuteTask` now serves the whole board — a bare `isExecuting` would put every card's
 * Execute button into "Starting…" while any one task spawned.
 */
describe("executingTaskId", () => {
  it("is exposed as an id rather than a flag", () => {
    const { result } = renderHook(() => useBoardActionsContext(), { wrapper });

    expect(result.current).toHaveProperty("executingTaskId");
    expect(result.current).not.toHaveProperty("isExecuting");
  });
});

it("refuses to be read outside the provider", () => {
  expect(() => renderHook(() => useBoardActionsContext())).toThrow(/BoardActionsProvider/);
});

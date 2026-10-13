import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { DiffTarget } from "@/types/bindings";
import type { DiffScope } from "@/components/execution/diff/scope";

const meta = vi.hoisted(() => ({
  current: {
    cwd: "C:/repo/.maestro/worktrees/session-7",
    project_id: 1,
    session_start_sha: null,
  } as {
    cwd: string;
    project_id: number;
    session_start_sha: string | null;
  },
}));
const diffTargets = vi.hoisted(() => ({ current: [] as DiffTarget[] }));
const commitAnchors = vi.hoisted(() => ({ current: [] as Array<string | null> }));

vi.mock("@/services/execution.service", () => ({
  useAcpSessionMeta: () => ({ data: meta.current }),
}));

vi.mock("@/services/worktree.service", () => ({
  useWorktreeDiffQuery: (_projectId: number | null, _cwd: string | null, target: DiffTarget) => {
    diffTargets.current.push(target);
    return { data: undefined, isLoading: false, error: null, refetch: () => {} };
  },
  useWorktreeDiffStatsQuery: () => ({ data: undefined }),
  useWorktreeCommitsQuery: (
    _projectId: number | null,
    _cwd: string | null,
    anchor: string | null,
  ) => {
    commitAnchors.current.push(anchor);
    return { data: [], isLoading: false };
  },
}));

const { useReviewChangesData } = await import("./useReviewChangesData");

function render(scope: DiffScope, baseBranch: string | null) {
  renderHook(() => useReviewChangesData({ sessionId: "s", isActive: true, scope, baseBranch }));
  return {
    target: diffTargets.current[diffTargets.current.length - 1],
    anchor: commitAnchors.current[commitAnchors.current.length - 1],
  };
}

beforeEach(() => {
  meta.current = { ...meta.current, session_start_sha: null };
  diffTargets.current = [];
  commitAnchors.current = [];
});

describe("useReviewChangesData", () => {
  it("anchors all changes and the commit list at the session start", () => {
    meta.current = { ...meta.current, session_start_sha: "abc123" };
    expect(render({ type: "all" }, "main")).toEqual({
      target: { type: "Commit", sha: "abc123" },
      anchor: "abc123",
    });
  });

  // Without this fallback the tab showed uncommitted changes only, and went empty on commit.
  it("falls back to the worktree base branch without a start sha", () => {
    expect(render({ type: "all" }, "main")).toEqual({
      target: { type: "BranchAll", branch: "main" },
      anchor: "main",
    });
  });

  it("shows the selected scope", () => {
    expect(render({ type: "uncommitted" }, "main").target).toEqual({ type: "Head" });
    expect(render({ type: "commits", oldest: "a1", newest: "b2" }, "main").target).toEqual({
      type: "CommitRange",
      from: "a1~1",
      to: "b2",
    });
  });
});

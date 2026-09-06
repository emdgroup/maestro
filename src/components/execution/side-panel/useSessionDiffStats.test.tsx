import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { DiffTarget, WorktreeDiffStats } from "@/types/bindings";

const meta = vi.hoisted(() => ({
  current: {
    cwd: "C:/repo/.maestro/worktrees/session-58",
    project_id: 1,
    session_start_sha: "abc123" as string | null,
  },
}));
const metaOptions = vi.hoisted(() => ({ current: undefined as unknown }));

/** Every `useWorktreeDiffStatsQuery` call this render made, in order. */
const statsCalls = vi.hoisted(() => ({
  current: [] as Array<{ target: DiffTarget; refetchInterval: number | false | undefined }>,
}));
const statsByTarget = vi.hoisted(() => ({
  current: new Map<string, WorktreeDiffStats>(),
}));
const statsError = vi.hoisted(() => ({ current: false }));
const refetches = vi.hoisted(() => ({ current: [] as string[] }));

vi.mock("@/services/execution.service", () => ({
  useAcpSessionMeta: (_key: number | null, options?: unknown) => {
    metaOptions.current = options;
    return { data: meta.current };
  },
}));

vi.mock("@/services/worktree.service", () => ({
  useWorktreeDiffStatsQuery: (
    _projectId: number | null,
    _cwd: string | null,
    target: DiffTarget,
    options?: { refetchInterval?: number | false },
  ) => {
    statsCalls.current.push({ target, refetchInterval: options?.refetchInterval });
    const key = target.type === "Commit" ? `Commit:${target.sha}` : target.type;
    return {
      data: statsError.current ? undefined : statsByTarget.current.get(key),
      isError: statsError.current,
      refetch: () => {
        refetches.current.push(key);
      },
    };
  },
}));

const { useSessionDiffStats } = await import("./useSessionDiffStats");

function stats(overrides: Partial<WorktreeDiffStats> = {}): WorktreeDiffStats {
  return { file_count: 0, insertions: 0, deletions: 0, untracked_count: 0, ...overrides };
}

beforeEach(() => {
  meta.current = {
    cwd: "C:/repo/.maestro/worktrees/session-58",
    project_id: 1,
    session_start_sha: "abc123",
  };
  metaOptions.current = undefined;
  statsCalls.current = [];
  statsByTarget.current = new Map();
  statsError.current = false;
  refetches.current = [];
});

describe("useSessionDiffStats", () => {
  it("anchors the headline at the start commit and measures the outstanding work against HEAD", () => {
    statsByTarget.current.set(
      "Commit:abc123",
      stats({ file_count: 11, insertions: 240, deletions: 58, untracked_count: 1 }),
    );
    statsByTarget.current.set("Head", stats({ file_count: 2, untracked_count: 1 }));

    const { result } = renderHook(() => useSessionDiffStats(58, true));

    expect(result.current.scope).toBe("session");
    // Untracked files are part of the change, so both counts include them.
    expect(result.current.changedFilesCount).toBe(12);
    expect(result.current.uncommittedFilesCount).toBe(3);
    expect(result.current.diffStats).toEqual({ insertions: 240, deletions: 58 });
    expect(result.current.isError).toBe(false);

    expect(statsCalls.current.map((c) => c.target)).toEqual([
      { type: "Commit", sha: "abc123" },
      { type: "Head" },
    ]);
  });

  it("committing moves the split without moving the headline", () => {
    const sinceStart = stats({ file_count: 12, insertions: 240, deletions: 58 });
    statsByTarget.current.set("Commit:abc123", sinceStart);
    statsByTarget.current.set("Head", stats({ file_count: 12 }));

    const { result, rerender } = renderHook(() => useSessionDiffStats(58, true));
    expect(result.current.changedFilesCount).toBe(12);
    expect(result.current.uncommittedFilesCount).toBe(12);

    // The agent commits: `git diff <start>` is unchanged, `git diff HEAD` empties.
    statsByTarget.current.set("Head", stats());
    rerender();

    expect(result.current.changedFilesCount).toBe(12);
    expect(result.current.uncommittedFilesCount).toBe(0);
  });

  it("degrades to uncommitted-only when the start commit is gone", () => {
    // What `get_acp_session_meta` reports once a rebase or reset has orphaned the commit.
    meta.current = { ...meta.current, session_start_sha: null };
    statsByTarget.current.set("Head", stats({ file_count: 3 }));

    const { result } = renderHook(() => useSessionDiffStats(58, true));

    expect(result.current.scope).toBe("uncommitted");
    expect(result.current.changedFilesCount).toBe(3);
    // Both queries collapse onto the same target, so TanStack dedupes them to one fetch.
    expect(statsCalls.current.every((c) => c.target.type === "Head")).toBe(true);
  });

  it("polls session meta only while the session is on screen, so an orphaned sha is noticed", () => {
    const { rerender } = renderHook(({ poll }) => useSessionDiffStats(58, poll), {
      initialProps: { poll: false },
    });
    expect(metaOptions.current).toEqual({ refetchInterval: false });
    expect(statsCalls.current.every((c) => c.refetchInterval === false)).toBe(true);

    statsCalls.current = [];
    rerender({ poll: true });
    expect(metaOptions.current).toEqual({ refetchInterval: 30000 });
    expect(statsCalls.current.every((c) => c.refetchInterval === 10000)).toBe(true);
  });

  it("refetches both stats when the session comes back on screen", () => {
    const { rerender } = renderHook(({ poll }) => useSessionDiffStats(58, poll), {
      initialProps: { poll: false },
    });
    expect(refetches.current).toEqual([]);

    // Polling is paused off screen and window-focus refetching is off globally, so without this
    // the card would show git state as of whenever the user last looked at it.
    rerender({ poll: true });
    expect(refetches.current).toEqual(["Commit:abc123", "Head"]);

    refetches.current = [];
    rerender({ poll: true });
    expect(refetches.current).toEqual([]);
  });

  it("reports a failed git diff rather than reading it as an empty one", () => {
    statsError.current = true;

    const { result } = renderHook(() => useSessionDiffStats(58, true));

    expect(result.current.isError).toBe(true);
    expect(result.current.changedFilesCount).toBeNull();
    expect(result.current.diffStats).toBeNull();
  });
});

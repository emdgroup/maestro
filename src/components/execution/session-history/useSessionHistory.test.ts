import { describe, it, expect } from "vitest";
import type { WorktreeWithStatus } from "@/types/bindings";
import { resumeWorkspace } from "./useSessionHistory";

const REPO = "/home/me/proj";
const worktrees = [
  { path: "/home/me/proj", branch_name: "main" },
  { path: "/home/me/proj/.maestro/worktrees/task-7", branch_name: "feat/seven" },
] as WorktreeWithStatus[];

describe("resumeWorkspace", () => {
  it("offers a new worktree when no folder was ever recorded", () => {
    expect(resumeWorkspace(null, REPO, worktrees)).toEqual({ workspaceMode: "NewWorktree" });
    expect(resumeWorkspace(undefined, REPO, worktrees)).toEqual({ workspaceMode: "NewWorktree" });
  });

  it("uses the project directory for a session recorded in the root", () => {
    expect(resumeWorkspace("", REPO, worktrees)).toEqual({ workspaceMode: "RepositoryDirectory" });
  });

  it("uses the project directory even when git does not list the root as a worktree", () => {
    expect(resumeWorkspace("", REPO, [worktrees[1]!])).toEqual({
      workspaceMode: "RepositoryDirectory",
    });
  });

  it("reuses the recorded worktree, resolved against the current root", () => {
    expect(resumeWorkspace(".maestro/worktrees/task-7", REPO, worktrees)).toEqual({
      workspaceMode: "ReuseWorkspace",
      worktree: worktrees[1],
    });
  });

  it("offers a new worktree when the recorded one no longer exists", () => {
    expect(resumeWorkspace(".maestro/worktrees/task-99", REPO, worktrees)).toEqual({
      workspaceMode: "NewWorktree",
    });
  });

  it("matches across separator styles", () => {
    const wt = {
      path: "C:\\dev\\proj\\.maestro\\worktrees\\task-7\\",
      branch_name: "feat/seven",
    } as WorktreeWithStatus;
    expect(resumeWorkspace(".maestro/worktrees/task-7", "C:/dev/proj", [wt])).toEqual({
      workspaceMode: "ReuseWorkspace",
      worktree: wt,
    });
  });
});

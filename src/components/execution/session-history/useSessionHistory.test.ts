import { describe, it, expect } from "vitest";
import { resolveRecordedWorktree } from "./useSessionHistory";

const REPO = "/home/me/proj";
const worktrees = [
  { path: "/home/me/proj", branch_name: "main" },
  { path: "/home/me/proj/.maestro/worktrees/task-7", branch_name: "feat/seven" },
];

describe("resolveRecordedWorktree", () => {
  it("gives up when no folder was ever recorded", () => {
    expect(resolveRecordedWorktree(null, REPO, worktrees)).toBeNull();
    expect(resolveRecordedWorktree(undefined, REPO, worktrees)).toBeNull();
  });

  it("reopens a session recorded in the project root at the root", () => {
    expect(resolveRecordedWorktree("", REPO, worktrees)).toEqual({
      cwd: REPO,
      branch: "main",
    });
  });

  it("reopens in the root even when git does not list it as a worktree", () => {
    expect(resolveRecordedWorktree("", REPO, [worktrees[1]!])).toEqual({
      cwd: REPO,
      branch: null,
    });
  });

  it("resolves a relative folder against the current root and carries its branch", () => {
    expect(resolveRecordedWorktree(".maestro/worktrees/task-7", REPO, worktrees)).toEqual({
      cwd: "/home/me/proj/.maestro/worktrees/task-7",
      branch: "feat/seven",
    });
  });

  it("gives up when the recorded worktree no longer exists", () => {
    expect(resolveRecordedWorktree(".maestro/worktrees/task-99", REPO, worktrees)).toBeNull();
  });

  it("matches across separator styles", () => {
    expect(
      resolveRecordedWorktree(".maestro/worktrees/task-7", "C:/dev/proj", [
        { path: "C:\\dev\\proj\\.maestro\\worktrees\\task-7\\", branch_name: "feat/seven" },
      ]),
    ).toEqual({ cwd: "C:\\dev\\proj\\.maestro\\worktrees\\task-7\\", branch: "feat/seven" });
  });
});

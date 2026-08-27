import type { CommitInfo, DiffTarget } from "@/types/bindings";

/**
 * Which slice of a branch's work is being reviewed.
 *
 * A single commit is just a one-long range, so there is one shape to map rather than two — and
 * `DiffTarget.CommitRange` expresses both without any backend change.
 */
export type DiffScope =
  | { type: "all" }
  | { type: "uncommitted" }
  | { type: "commits"; oldest: string; newest: string };

/**
 * `git log` lists newest first, so a selection spanning indices `i..j` runs from `commits[max]`
 * (oldest) to `commits[min]` (newest). `null` when nothing is selected.
 */
export function commitSpan(
  shas: Set<string>,
  commits: CommitInfo[],
): { oldest: string; newest: string } | null {
  const indices = commits.flatMap((commit, index) => (shas.has(commit.sha) ? [index] : []));
  if (indices.length === 0) return null;
  return {
    newest: commits[Math.min(...indices)].sha,
    oldest: commits[Math.max(...indices)].sha,
  };
}

/**
 * Every sha between two commits inclusive.
 *
 * Git can only diff a contiguous range, so picking two ends fills in what lies between rather than
 * leaving un-clickable gaps in the list.
 */
export function fillSpan(commits: CommitInfo[], fromSha: string, toSha: string): Set<string> {
  const from = commits.findIndex((c) => c.sha === fromSha);
  const to = commits.findIndex((c) => c.sha === toSha);
  if (from < 0 || to < 0) return new Set();
  const [start, end] = from <= to ? [from, to] : [to, from];
  return new Set(commits.slice(start, end + 1).map((c) => c.sha));
}

/** Where to take the diff from, for a scope. `startSha` anchors "all changes" for a task. */
export function scopeToDiffTarget(
  scope: DiffScope,
  { startSha, baseBranch }: { startSha?: string | null; baseBranch?: string | null },
): DiffTarget {
  switch (scope.type) {
    case "all":
      if (startSha) return { type: "Commit", sha: startSha };
      if (baseBranch) return { type: "BranchAll", branch: baseBranch };
      return { type: "Head" };
    case "uncommitted":
      return { type: "Head" };
    case "commits":
      // `~1` so the oldest commit's own changes are included, not excluded as the range's base.
      return { type: "CommitRange", from: `${scope.oldest}~1`, to: scope.newest };
  }
}

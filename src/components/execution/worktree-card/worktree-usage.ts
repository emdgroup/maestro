import type { ActiveSessionInfo, WorktreeWithStatus } from "@/types/bindings";

/** Who and what inside Maestro is currently pointed at one worktree. */
export interface WorktreeUsage {
  task: { id: number; name: string } | null;
  /** ACP sessions running here, each of which the footer links to individually. */
  agents: ActiveSessionInfo[];
  /**
   * Shells running here, counted but never linked. A shell is a terminal the user opened; there is
   * no per-session view to navigate to and nothing to say about it beyond that it exists.
   */
  shellCount: number;
}

/**
 * Whether `cwd` is a worktree or a directory inside it.
 *
 * Mirrors the backend's `path_is_within`, with one addition it does not need: a session's recorded
 * cwd can carry native separators while a worktree path is assembled with forward slashes, so both
 * sides are normalised before comparing. Prefix matching alone would also make `.../session-3` a
 * match for `.../session-31`, which is why the remainder has to start at a separator.
 */
export function pathIsWithin(cwd: string, worktreePath: string): boolean {
  const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");
  const haystack = normalize(cwd);
  const root = normalize(worktreePath);
  if (!haystack.startsWith(root)) return false;
  const rest = haystack.slice(root.length);
  return rest === "" || rest.startsWith("/");
}

/**
 * Which sessions belong to which worktree, joined by path rather than by branch.
 *
 * The branch a session recorded at spawn goes stale as soon as anyone checks out inside it, and a
 * detached worktree has no branch to match on at all — the directory is the thing that does not
 * change.
 *
 * Containment alone is not enough to decide ownership, because Maestro puts its worktrees under
 * `.maestro/worktrees/` *inside* the repository: an agent working in `session-3` is, by path, also
 * running inside the repository root's own checkout. Testing each worktree independently therefore
 * credited the root card with every agent in the project. A session belongs to the innermost
 * worktree containing it — the longest matching path — which is the checkout it is actually
 * editing.
 *
 * Pass every worktree, not the filtered view: a session hidden by a search or status filter still
 * belongs to its own worktree rather than to the root.
 */
export function sessionsByWorktree(
  worktrees: WorktreeWithStatus[],
  sessions: ActiveSessionInfo[],
): Map<string, ActiveSessionInfo[]> {
  const byPath = new Map<string, ActiveSessionInfo[]>(worktrees.map((wt) => [wt.path, []]));
  for (const session of sessions) {
    let bestPath: string | null = null;
    let bestDepth = -1;
    for (const wt of worktrees) {
      if (!pathIsWithin(session.cwd, wt.path)) continue;
      const depth = normalizePath(wt.path).length;
      if (depth > bestDepth) {
        bestDepth = depth;
        bestPath = wt.path;
      }
    }
    if (bestPath !== null) byPath.get(bestPath)!.push(session);
  }
  return byPath;
}

/**
 * What is using one worktree.
 *
 * `sessionsHere` must already be scoped to this worktree — see `sessionsByWorktree`, which owns the
 * path matching so that nested worktrees are attributed once rather than to every ancestor.
 */
export function worktreeUsage(
  worktree: WorktreeWithStatus,
  sessionsHere: ActiveSessionInfo[],
): WorktreeUsage {
  return {
    task:
      worktree.task_id != null
        ? { id: worktree.task_id, name: worktree.task_name ?? `Task ${worktree.task_id}` }
        : null,
    agents: sessionsHere.filter((session) => session.execution_mode === "acp"),
    shellCount: sessionsHere.filter((session) => session.execution_mode === "pty").length,
  };
}

/** Whether the card shows a footer at all — its presence is the "in use" indicator. */
export function isInUse(usage: WorktreeUsage): boolean {
  return usage.task !== null || usage.agents.length > 0 || usage.shellCount > 0;
}

/** What to call an ACP session in the footer, preferring the name the user gave it. */
export function agentLabel(session: ActiveSessionInfo): string {
  return session.session_name ?? session.agent_id ?? session.task_name ?? "Agent";
}

/**
 * How long ago something happened, compactly.
 *
 * Floored at a minute: `formatDistanceToNow` renders anything younger as "less than a minute ago",
 * which spends four words on the least informative case. A timestamp in the future — clock skew
 * between a remote worktree and this host — floors to the same place rather than reading "in 3
 * minutes" on a card about work that has already happened.
 */
export function relativeAge(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;

  const minutes = Math.max(1, Math.round((now - then) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d`;
  return `${Math.round(days / 7)} w`;
}

/**
 * The worktree's identity: the task it was created for, else the folder it lives in.
 *
 * The folder name is what the user sees on disk and in a terminal prompt, so it is the fallback
 * rather than the branch — and it stays available in the card's tooltip either way.
 */
export function worktreeTitle(worktree: WorktreeWithStatus): string {
  return worktree.task_name ?? folderName(worktree.path);
}

export function folderName(path: string): string {
  const segments = normalizePath(path).split("/");
  return segments[segments.length - 1] || path;
}

/**
 * Where the worktree sits, said the way the user would say it: `.maestro/worktrees/session-31`.
 *
 * The folder name alone is ambiguous once a project has hand-made worktrees outside `.maestro/`,
 * and the absolute path is mostly a home directory nobody needs to read. The repository root has
 * no relative path to give, so it answers with its own folder name; a worktree living outside the
 * repository — which git permits — falls back to its full path rather than inventing one.
 */
export function relativeWorktreePath(path: string, repoPath: string): string {
  const target = normalizePath(path);
  const root = normalizePath(repoPath);
  if (target === root) return folderName(target);
  return target.startsWith(`${root}/`) ? target.slice(root.length + 1) : target;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

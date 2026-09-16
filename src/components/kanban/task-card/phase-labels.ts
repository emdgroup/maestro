import type { Task, TaskPhase, PhaseStatus } from "@/types/bindings";

export const PHASE_LABELS: Record<TaskPhase, string> = {
  Spawning: "Starting",
  Refining: "Refining",
  Drafting: "Planning",
  PlanReview: "Plan review",
  Implementing: "Implementing",
  Rework: "Rework",
  SelfReview: "Self review",
  Approval: "Approval",
  AwaitingMerge: "Awaiting merge",
};

/**
 * What the card says instead once the ball is with the user.
 *
 * A phase name answers "which stage is this", which is the wrong question the moment the task is
 * waiting on a person — then the only question is what is being asked of them. `Approval` is the
 * worst of them: it reads as a verdict already delivered, and it appears directly after a reviewer
 * whose message says `APPROVED`.
 *
 * Deliberately not exhaustive. A phase absent here has no user gate — or, like a `Blocked` agent,
 * already says so through the pulsing border it is the only phase status to get.
 */
export const USER_GATE_LABELS: Partial<Record<TaskPhase, string>> = {
  Refining: "Proposal for you",
  PlanReview: "Plan for you",
  Approval: "Needs your approval",
};

/**
 * Three intensities, keyed on `phase_status`. Only `Blocked` animates: it is the one case where an
 * agent is stopped dead waiting on the user. Spreading the pulse across every card the user owns —
 * including a review gate untouched for days — is what would turn it into wallpaper.
 *
 * These read apart only because the card's own border is neutral; they each take over the border
 * rather than sitting outside a coloured one.
 */
export const PHASE_STATUS_RING: Partial<Record<PhaseStatus, string>> = {
  Blocked: "animate-glow-warning border-warning",
  Waiting: "border-accent ring-1 ring-accent/40",
  Failed: "border-destructive ring-1 ring-destructive/40",
};

/**
 * Only shown when it says something the column does not. A merged task is finished and Done
 * already conveys that; `LocalOnly` means the changes are still sitting in a worktree, and
 * `NoChanges` means the agent finished empty-handed — both are things the user has to be told.
 */
export const COMPLETION_LABELS: Partial<Record<NonNullable<Task["completion"]>, string>> = {
  LocalOnly: "not merged",
  NoChanges: "no changes",
};

/**
 * What each CI state means for the user, rather than what the forge called it. "checks passed" and
 * "CI failing" describe the build; the question at this card is only ever whether the pull request
 * can be merged, so that is what these answer.
 */
export const CI_LABELS: Record<NonNullable<Task["pull_request_ci"]>, string> = {
  Passing: "ready to merge",
  Failing: "needs fixing",
  Pending: "waiting for CI",
};

export const CI_TONES: Record<NonNullable<Task["pull_request_ci"]>, string> = {
  Passing: "text-success",
  Failing: "text-destructive",
  Pending: "text-muted-foreground",
};

/**
 * `NULL` — nothing has been reported. Not a key above, because `pull_request_ci` cannot hold it.
 *
 * It used to render as no label at all, which read the same as no sweep running. It means three
 * things at once — not swept yet, no CI in the repository, and a forge that cannot report CI at
 * all — and none of them is on the bindings, so the label can only say that nothing is known.
 *
 * Deliberately not "ready to merge": a queued build that has not registered yet is indistinguishable
 * from a repository with no CI, and the burst in `usePullRequestPoll` only buys 30s of cover. Green
 * here would tell a user to merge on the strength of a check nobody has run. Muted, like the
 * Worktrees panel's `unknown` (`@/components/execution/worktree-card/pullRequestCi`).
 */
export const CI_UNREPORTED = { label: "no checks reported", tone: "text-muted-foreground" };

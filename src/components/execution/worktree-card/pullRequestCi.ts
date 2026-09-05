import type { PullRequestCheckInfo, PullRequestCiRollup } from "@/types/bindings";

/** What a pull request's checks add up to, as one mark. */
export type CiRollup = "passing" | "failing" | "running" | "unknown";

export interface CiStatus {
  rollup: CiRollup;
  /** Tooltip text: the verdict, or the failing check names when there are any. */
  label: string;
}

/**
 * Colour for the pull request icon itself, which is the indicator.
 *
 * There is no separate dot: the metrics row is already six segments wide on a 288px card, and a
 * mark whose only job is to be one of three colours can be the glyph that is already there.
 */
export const CI_TONE: Record<CiRollup, string> = {
  passing: "text-success",
  failing: "text-destructive",
  running: "text-warning",
  unknown: "text-muted-foreground",
};

const CI_LABEL: Record<CiRollup, string> = {
  passing: "All checks passed",
  failing: "Checks failing",
  running: "Checks running",
  unknown: "No checks reported",
};

export const UNKNOWN_CI: CiStatus = { rollup: "unknown", label: CI_LABEL.unknown };

/**
 * The verdict for a single coloured indicator.
 *
 * A failure outranks a run still in progress here, which is the opposite of `summarise_checks` on
 * the Rust side — and deliberately so. That one decides whether to start a fix agent, where acting
 * on a half-finished matrix would be wrong. This one has a single mark and no room for "3 of 4
 * done", so the only question it can answer is whether anything is broken, and a check that has
 * already failed answers it whatever the rest of the matrix is still doing.
 */
export function summariseChecks(checks: PullRequestCheckInfo[] | undefined): CiStatus {
  if (!checks || checks.length === 0) return UNKNOWN_CI;

  const failing = checks.filter((check) => check.status === "Failed").map((check) => check.name);
  if (failing.length > 0) return { rollup: "failing", label: `Failing: ${failing.join(", ")}` };

  const rollup = checks.some((check) => check.status === "Running") ? "running" : "passing";
  return { rollup, label: CI_LABEL[rollup] };
}

/**
 * The backend's verdict in the display vocabulary above.
 *
 * Two spellings of one idea, kept apart on purpose: the generated enum is PascalCase because that is
 * how every status enum crosses the IPC boundary, and this one keys `CI_TONE` and the icon table
 * beside it. The map is four lines in one place rather than a rename rippling through both.
 *
 * The rollup carries no names, which is why there is no label here — a panel row draws one icon.
 * Where names *are* shown, the caller has the checks themselves and uses [`summariseChecks`].
 */
export function rollupOfCi(ci: PullRequestCiRollup | undefined): CiRollup {
  switch (ci) {
    case "Passing":
      return "passing";
    case "Failing":
      return "failing";
    case "Running":
      return "running";
    default:
      return "unknown";
  }
}

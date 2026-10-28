import type { LoopCheck, LoopCheckEntry, LoopCheckKind, LoopConfig } from "@/types/bindings";
import { formatDuration, orderPatterns, parseDuration } from "./loop-state";

/**
 * One row of the editor: a check, or a step run before the checks, whose label is its reason.
 * `key` is the row's own, since a new check has no id yet.
 */
export interface CheckDraft {
  key: string;
  id: number | null;
  kind: LoopCheckKind;
  label: string;
  command: string;
  /** Its own time limit in minutes, as typed. Blank takes the loop's default. */
  timeoutMinutes: string;
}

/** What the loop editor holds, as typed: numbers stay text until saved. */
export interface LoopDraft {
  checks: CheckDraft[];
  /** The sealed patterns, in the order they are stored. */
  sealedPaths: string[];
  /** Paths the user took out of the sealed list, which prefilling does not add back. */
  dismissed: string[];
  maxIterations: string;
  buildTime: string;
  stallLimit: string;
  /** The time limit of a row without its own, kept as stored. */
  checkTimeoutSecs: number;
}

let nextKey = 0;
export const rowKey = () => `check-${++nextKey}`;

export const blankCheck = (kind: LoopCheckKind = "Command"): CheckDraft => ({
  key: rowKey(),
  id: null,
  kind,
  label: "",
  command: "",
  timeoutMinutes: "",
});

/** The daemon's defaults, `LoopConfig::default`. */
export function emptyLoopDraft(): LoopDraft {
  return {
    checks: [blankCheck()],
    sealedPaths: [],
    dismissed: [],
    maxIterations: "10",
    buildTime: "2h",
    stallLimit: "3",
    checkTimeoutSecs: 10 * 60,
  };
}

/** A stored loop as the editor shows it. Proposals waiting for an answer are not the user's list. */
export function loopDraftFrom(config: LoopConfig, checks: LoopCheck[]): LoopDraft {
  return {
    checks: checks
      .filter((c) => !c.proposed || c.accepted)
      .map((c) => ({
        key: rowKey(),
        id: c.id,
        kind: c.kind,
        label: c.label,
        command: c.command ?? "",
        timeoutMinutes: c.timeout_secs ? String(Math.ceil(c.timeout_secs / 60)) : "",
      })),
    sealedPaths: config.sealed_paths,
    dismissed: [],
    maxIterations: String(config.max_iterations),
    buildTime: formatDuration(config.max_build_secs),
    stallLimit: String(config.stall_limit),
    checkTimeoutSecs: config.check_timeout_secs,
  };
}

/** The steps run before the checks, in the order they run. */
export const setupDrafts = (draft: LoopDraft) => draft.checks.filter((c) => c.kind === "Setup");

/** A row of the loop's "Done when" list: one of the user's checks, or a proposal to answer. */
export type DoneWhenRow =
  | { kind: "check"; draft: CheckDraft; live: LoopCheck | null }
  | { kind: "proposal"; live: LoopCheck };

/**
 * The user's checks as edited, each with the state the daemon last gave it, then the proposals
 * still waiting for an answer. A check the draft adds has no state yet, and one it removes is gone
 * from the list before it is saved. The steps have a card of their own.
 */
export function doneWhenRows(drafts: CheckDraft[], live: LoopCheck[]): DoneWhenRow[] {
  const byId = new Map(live.map((c) => [c.id, c]));
  return [
    ...drafts
      .filter((draft) => draft.kind !== "Setup")
      .map((draft) => ({
        kind: "check" as const,
        draft,
        live: draft.id === null ? null : (byId.get(draft.id) ?? null),
      })),
    ...live
      .filter((c) => c.proposed && !c.accepted)
      .map((c) => ({ kind: "proposal" as const, live: c })),
  ];
}

/** The config and checks to save, or what is wrong with the draft. */
export function loopFromDraft(
  draft: LoopDraft,
): { config: LoopConfig; checks: LoopCheckEntry[] } | { error: string } {
  const whole = (text: string, name: string) => {
    const n = Number(text.trim());
    return Number.isInteger(n) && n >= 1 ? n : `${name} must be a whole number of at least 1`;
  };
  const maxIterations = whole(draft.maxIterations, "Iterations");
  const stallLimit = whole(draft.stallLimit, "The no-change limit");
  const buildSecs = parseDuration(draft.buildTime);
  for (const value of [maxIterations, stallLimit]) {
    if (typeof value === "string") return { error: value };
  }
  if (buildSecs === null) return { error: "Time per Build reads like 2h, 90m or 1h 30m" };
  const filled = draft.checks.filter((c) => c.label.trim() || c.command.trim());
  // A step without a reason is named by its command. The steps go first, as they run.
  const rows = [
    ...filled
      .filter((c) => c.kind === "Setup")
      .map((c) => ({ ...c, label: c.label.trim() || c.command.trim() })),
    ...filled.filter((c) => c.kind !== "Setup"),
  ];
  const unnamed = rows.find((c) => !c.label.trim());
  if (unnamed) return { error: "Every check needs a sentence saying what it checks" };
  const runs = (c: CheckDraft) => c.kind === "Command" || c.kind === "Setup";
  const commandless = rows.find((c) => runs(c) && !c.command.trim());
  if (commandless) return { error: `"${commandless.label.trim()}" needs a command to run` };
  const checks: LoopCheckEntry[] = [];
  for (const c of rows) {
    const limit = c.timeoutMinutes.trim() ? whole(c.timeoutMinutes, "Its time limit") : null;
    if (typeof limit === "string") return { error: `"${c.label.trim()}": ${limit} minute` };
    checks.push({
      id: c.id,
      kind: c.kind,
      label: c.label.trim(),
      command: runs(c) ? c.command.trim() : null,
      timeout_secs: runs(c) && limit !== null ? limit * 60 : null,
    });
  }
  return {
    config: {
      max_iterations: maxIterations as number,
      max_build_secs: buildSecs,
      stall_limit: stallLimit as number,
      check_timeout_secs: draft.checkTimeoutSecs,
      sealed_paths: orderPatterns(draft.sealedPaths),
    },
    checks,
  };
}

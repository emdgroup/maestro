import type {
  LoopCheck,
  LoopCheckEntry,
  LoopCheckKind,
  LoopConfig,
  LoopHiddenFile,
} from "@/types/bindings";
import { formatDuration, parseDuration } from "./loop-state";

/** One row of the editor. `key` is the row's own, since a new check has no id yet. */
export interface CheckDraft {
  key: string;
  id: number | null;
  kind: LoopCheckKind;
  label: string;
  command: string;
}

/** What the loop editor holds, as typed: numbers stay text until saved. */
export interface LoopDraft {
  checks: CheckDraft[];
  sealedPaths: string[];
  /** Paths the user took out of the sealed list, which prefilling does not add back. */
  dismissed: string[];
  hiddenFiles: LoopHiddenFile[];
  setupCommand: string;
  maxIterations: string;
  agentTime: string;
  stallLimit: string;
  timeoutMinutes: string;
}

let nextKey = 0;
export const rowKey = () => `check-${++nextKey}`;

export const blankCheck = (kind: LoopCheckKind = "Command"): CheckDraft => ({
  key: rowKey(),
  id: null,
  kind,
  label: "",
  command: "",
});

/** The daemon's defaults, `LoopConfig::default`. */
export function emptyLoopDraft(): LoopDraft {
  return {
    checks: [blankCheck()],
    sealedPaths: [],
    dismissed: [],
    hiddenFiles: [],
    setupCommand: "",
    maxIterations: "10",
    agentTime: "2h",
    stallLimit: "3",
    timeoutMinutes: "10",
  };
}

/** A stored loop as the editor shows it. Proposals waiting for an answer are not the user's list. */
export function loopDraftFrom(
  config: LoopConfig,
  checks: LoopCheck[],
  hiddenFiles: LoopHiddenFile[],
): LoopDraft {
  return {
    checks: checks
      .filter((c) => !c.proposed || c.accepted)
      .map((c) => ({
        key: rowKey(),
        id: c.id,
        kind: c.kind,
        label: c.label,
        command: c.command ?? "",
      })),
    sealedPaths: config.sealed_paths,
    dismissed: [],
    hiddenFiles,
    setupCommand: config.setup_command ?? "",
    maxIterations: String(config.max_iterations),
    agentTime: formatDuration(config.max_agent_secs),
    stallLimit: String(config.stall_limit),
    timeoutMinutes: String(Math.round(config.check_timeout_secs / 60)),
  };
}

/** A row of the loop's "Done when" list: one of the user's checks, or a proposal to answer. */
export type DoneWhenRow =
  | { kind: "check"; draft: CheckDraft; live: LoopCheck | null }
  | { kind: "proposal"; live: LoopCheck };

/**
 * The user's checks as edited, each with the state the daemon last gave it, then the proposals
 * still waiting for an answer. A check the draft adds has no state yet, and one it removes is gone
 * from the list before it is saved.
 */
export function doneWhenRows(drafts: CheckDraft[], live: LoopCheck[]): DoneWhenRow[] {
  const byId = new Map(live.map((c) => [c.id, c]));
  return [
    ...drafts.map((draft) => ({
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
  const timeout = whole(draft.timeoutMinutes, "The check timeout");
  const agentSecs = parseDuration(draft.agentTime);
  for (const value of [maxIterations, stallLimit, timeout]) {
    if (typeof value === "string") return { error: value };
  }
  if (agentSecs === null) return { error: "Agent time reads like 2h, 90m or 1h 30m" };
  const rows = draft.checks.filter((c) => c.label.trim() || c.command.trim());
  const unnamed = rows.find((c) => !c.label.trim());
  if (unnamed) return { error: "Every check needs a sentence saying what it checks" };
  const commandless = rows.find((c) => c.kind === "Command" && !c.command.trim());
  if (commandless) return { error: `"${commandless.label.trim()}" needs a command to run` };
  return {
    config: {
      max_iterations: maxIterations as number,
      max_agent_secs: agentSecs,
      stall_limit: stallLimit as number,
      check_timeout_secs: (timeout as number) * 60,
      setup_command: draft.setupCommand.trim() || null,
      sealed_paths: draft.sealedPaths,
    },
    checks: rows.map((c) => ({
      id: c.id,
      kind: c.kind,
      label: c.label.trim(),
      command: c.kind === "Command" ? c.command.trim() : null,
    })),
  };
}

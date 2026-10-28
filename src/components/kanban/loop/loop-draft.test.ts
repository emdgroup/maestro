import { describe, expect, it } from "vitest";
import type { LoopCheck } from "@/types/bindings";
import {
  blankCheck,
  doneWhenRows,
  emptyLoopDraft,
  loopFromDraft,
  type CheckDraft,
} from "./loop-draft";

const live = (id: number, patch: Partial<LoopCheck> = {}): LoopCheck => ({
  id,
  position: id,
  kind: "Command",
  label: `check ${id}`,
  command: "true",
  state: "Pass",
  proposed: false,
  accepted: false,
  updated_at: "",
  ...patch,
});

const draft = (id: number | null, label: string, patch: Partial<CheckDraft> = {}): CheckDraft => ({
  ...blankCheck(),
  id,
  label,
  ...patch,
});

describe("doneWhenRows", () => {
  it("pairs each edited check with its stored state, then lists unanswered proposals", () => {
    const rows = doneWhenRows(
      [draft(2, "renamed"), draft(9, "install", { kind: "Setup" }), draft(null, "new one")],
      [
        live(1),
        live(2, { state: "Fail" }),
        live(3, { proposed: true }),
        live(4, { proposed: true, accepted: true }),
      ],
    );
    expect(
      rows.map((r) =>
        r.kind === "check" ? [r.draft.label, r.live?.state ?? null] : ["proposal", r.live.id],
      ),
    ).toEqual([
      ["renamed", "Fail"],
      ["new one", null],
      ["proposal", 3],
    ]);
  });
});

describe("loopFromDraft", () => {
  const save = (checks: CheckDraft[]) => loopFromDraft({ ...emptyLoopDraft(), checks });

  it("puts the steps first, named by their command when they give no reason", () => {
    const read = save([
      draft(null, "Tests pass", { command: "bun run test", timeoutMinutes: "5" }),
      draft(null, "", { kind: "Setup", command: "bun install" }),
      draft(null, "No API change", { kind: "Judge", command: "ignored", timeoutMinutes: "3" }),
    ]);
    expect("checks" in read && read.checks).toEqual([
      { id: null, kind: "Setup", label: "bun install", command: "bun install", timeout_secs: null },
      {
        id: null,
        kind: "Command",
        label: "Tests pass",
        command: "bun run test",
        timeout_secs: 300,
      },
      { id: null, kind: "Judge", label: "No API change", command: null, timeout_secs: null },
    ]);
    expect("config" in read && read.config.check_timeout_secs).toBe(600);
  });

  it("refuses a step without a command and a time limit that is not whole minutes", () => {
    expect(save([draft(null, "Install", { kind: "Setup" })])).toEqual({
      error: '"Install" needs a command to run',
    });
    expect(save([draft(null, "Tests", { command: "x", timeoutMinutes: "1.5" })])).toEqual({
      error: '"Tests": Its time limit must be a whole number of at least 1 minute',
    });
  });
});

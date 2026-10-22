import { describe, expect, it } from "vitest";
import type { LoopCheck } from "@/types/bindings";
import { blankCheck, doneWhenRows, type CheckDraft } from "./loop-draft";

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

const draft = (id: number | null, label: string): CheckDraft => ({
  ...blankCheck(),
  id,
  label,
});

describe("doneWhenRows", () => {
  it("pairs each edited check with its stored state, then lists unanswered proposals", () => {
    const rows = doneWhenRows(
      [draft(2, "renamed"), draft(null, "new one")],
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

import { describe, expect, it } from "vitest";
import type { AutomationRun } from "@/types/bindings";
import { entriesOf, waitDuration } from "./runs";

const run = {
  id: "r",
  automation_id: "a",
  project_path: "/p",
  automation_name: "A",
  status: "running",
  scheduled: false,
  started_at: new Date(0).toISOString(),
  session_id: "s",
} as AutomationRun;

describe("waitDuration", () => {
  it("counts from when the run started waiting, not from when it started", () => {
    const [entry] = entriesOf([run], [], {
      s: { status: "awaiting_input", stateChangedAt: 50_000, label: null, seen: false },
    });
    expect(entry.state).toBe("awaiting");
    expect(waitDuration(entry, 55_000)).toBe("5s");
  });
});

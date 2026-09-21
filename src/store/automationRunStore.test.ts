import { beforeEach, describe, expect, it } from "vitest";
import { useAutomationRunStore } from "./automationRunStore";

const state = () => useAutomationRunStore.getState();

beforeEach(() => {
  useAutomationRunStore.setState({ runs: {} });
});

describe("automationRunStore.observe", () => {
  // The bug this rules out: the session list is fetched before the spawn lands in it, so a naive
  // "not in the list means over" ends every run the instant it starts.
  it("keeps a run the session list has not caught up with yet", () => {
    state().start("a", "7");
    state().observe([]);
    expect(state().runs.a).toEqual({ sessionId: "7", seen: false });
  });

  it("ends a run once its session has been seen and then disappears", () => {
    state().start("a", "7");
    state().observe(["7"]);
    expect(state().runs.a?.seen).toBe(true);

    state().observe([]);
    expect(state().runs.a).toBeUndefined();
  });

  it("leaves other automations' runs alone", () => {
    state().start("a", "7");
    state().start("b", "8");
    state().observe(["7", "8"]);
    state().observe(["8"]);

    expect(state().runs.a).toBeUndefined();
    expect(state().runs.b?.sessionId).toBe("8");
  });

  it("finish drops a run that never reached the list", () => {
    state().start("a", "7");
    state().finish("a");
    expect(state().runs.a).toBeUndefined();
  });
});

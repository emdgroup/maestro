import { describe, it, expect } from "vitest";
import { executionQueryKeys } from "./execution.service";

describe("executionQueryKeys.agentConfig", () => {
  /**
   * The model belongs in the key because the answer depends on it: effort is a per-model setting,
   * so a probe answered against the agent's default model reports the wrong effort list for every
   * profile that named another one. Without this the cache would hand that wrong list back for
   * ever, since the query is `staleTime: Infinity`.
   */
  it("separates two models of the same agent", () => {
    const a = executionQueryKeys.agentConfig("codex", "/repo", { type: "local" }, "gpt-5-codex");
    const b = executionQueryKeys.agentConfig("codex", "/repo", { type: "local" }, "gpt-5-mini");

    expect(a).not.toEqual(b);
  });

  /** Same agent, same cwd, same model is one probe — four profiles must not spawn four sessions. */
  it("is stable for the same agent, directory and model", () => {
    expect(
      executionQueryKeys.agentConfig("codex", "/repo", { type: "local" }, "gpt-5-codex"),
    ).toEqual(executionQueryKeys.agentConfig("codex", "/repo", { type: "local" }, "gpt-5-codex"));
  });

  /** "No model chosen" is its own entry, not a wildcard sharing whichever model probed last. */
  it("gives an unset model a key of its own", () => {
    expect(executionQueryKeys.agentConfig("codex", "/repo", { type: "local" }, "")).not.toEqual(
      executionQueryKeys.agentConfig("codex", "/repo", { type: "local" }, "gpt-5-codex"),
    );
  });
});

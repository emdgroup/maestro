import { describe, expect, it } from "vitest";
import { resolveDefaultAgentFallback } from "./useDefaultAgentFallback";

function inputs(overrides: Partial<Parameters<typeof resolveDefaultAgentFallback>[0]> = {}) {
  return {
    projectId: 1,
    ready: true,
    defaultAgent: null,
    agentIds: ["claude-acp", "codex"],
    applied: new Set<number>(),
    ...overrides,
  };
}

describe("resolveDefaultAgentFallback", () => {
  /// The whole point: a project that has never opened Settings could not start a task, because
  /// Implementation falls back to the project default and profiles start empty.
  it("adopts the first installed agent when the project has no default", () => {
    expect(resolveDefaultAgentFallback(inputs())).toBe("claude-acp");
  });

  it("leaves an existing default alone", () => {
    expect(resolveDefaultAgentFallback(inputs({ defaultAgent: "codex" }))).toBeNull();
  });

  /// A still-loading query answers `null` for the default and `[]` for the agent list, which is
  /// indistinguishable from the real thing. Writing off that would set a default from an empty
  /// list, or overwrite one the user had already chosen.
  it("waits for both queries before deciding", () => {
    expect(resolveDefaultAgentFallback(inputs({ ready: false }))).toBeNull();
  });

  /// Nothing to pick, and inventing an id would surface as a spawn failure later instead of the
  /// "install an agent" message the user needs now.
  it("writes nothing when no agent is installed", () => {
    expect(resolveDefaultAgentFallback(inputs({ agentIds: [] }))).toBeNull();
  });

  /// The write invalidates the settings query it reads, so between the write and its result the
  /// inputs still say "no default". Without the guard that is a second write of the same value.
  it("does not write twice for the same project", () => {
    expect(resolveDefaultAgentFallback(inputs({ applied: new Set([1]) }))).toBeNull();
    expect(resolveDefaultAgentFallback(inputs({ projectId: 2, applied: new Set([1]) }))).toBe(
      "claude-acp",
    );
  });

  it("does nothing without a project", () => {
    expect(resolveDefaultAgentFallback(inputs({ projectId: null }))).toBeNull();
  });
});

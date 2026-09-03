import { describe, expect, it } from "vitest";
import { resolveAgentIntro } from "./useProjectAgentIntro";

describe("resolveAgentIntro", () => {
  /// A new project's board looks ready and is not — an agent has to be chosen before anything
  /// runs. Landing on the page that says which one was picked is how the user finds that out.
  it("sends a project's first open to the agent settings", () => {
    expect(resolveAgentIntro(1, null, true, false)).toEqual({ show: true, remember: true });
  });

  it("does not show it again once seen", () => {
    expect(resolveAgentIntro(1, null, true, true)).toEqual({ show: false, remember: false });
  });

  /// A project with a startup tab has been configured by someone, so it is not new and the user's
  /// stated preference outranks ours. Still recorded as seen, so switching the startup tab off
  /// later does not spring the introduction on them.
  it("yields to an explicit startup tab, and does not wait to try again", () => {
    expect(resolveAgentIntro(1, "worktrees", true, false)).toEqual({
      show: false,
      remember: true,
    });
  });

  /// `undefined` from the query means "not known yet", and reading it as "no startup tab" would
  /// redirect one render before the project's own preference arrived.
  it("decides nothing until the project settings have resolved", () => {
    expect(resolveAgentIntro(1, undefined, false, false)).toEqual({
      show: false,
      remember: false,
    });
  });

  it("does nothing without a project", () => {
    expect(resolveAgentIntro(null, null, true, false)).toEqual({ show: false, remember: false });
  });
});

import { describe, expect, it } from "vitest";
import { resolveDeepLinkedPage, visiblePages } from "./settings-registry";

const inProject = visiblePages({ inProject: true, isGitRepo: true });
const onWelcome = visiblePages({ inProject: false, isGitRepo: false });

describe("resolveDeepLinkedPage", () => {
  /// What the "install an agent" message and a project's first open both ask for.
  it("opens a page this host offers", () => {
    expect(resolveDeepLinkedPage(inProject, "agents")).toBe("agents");
  });

  it("leaves the selection alone when nothing is pending", () => {
    expect(resolveDeepLinkedPage(inProject, null)).toBeNull();
  });

  /// The welcome screen registers no project pages at all, so adopting one would select a page
  /// `SettingsPage` does not render — a blank pane where the fallback to the first page belongs.
  it("ignores a page this host does not offer", () => {
    expect(resolveDeepLinkedPage(onWelcome, "agents")).toBeNull();
  });

  it("ignores an id that names no page", () => {
    expect(resolveDeepLinkedPage(inProject, "nonsense")).toBeNull();
  });
});

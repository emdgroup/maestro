import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ConnectionKey } from "@/types/bindings";
import type { SessionShipState } from "./useSessionShipState";

vi.mock("@/services/task.service", () => ({
  useTaskAttachmentsQuery: () => ({ data: [] }),
  useTasksQuery: () => ({ data: [] }),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/lib/file-opener", () => ({ openFileWithConnection: vi.fn() }));
vi.mock("./OpenPullRequestDialog", () => ({ OpenPullRequestDialog: () => null }));

const { OverviewPanel } = await import("./OverviewPanel");

const ship: SessionShipState = {
  branch: "maestro/great-lynx-58",
  projectId: 1,
  needsPush: false,
  action: "open-pull-request",
  blocker: null,
  pullRequest: null,
  baseBranch: "origin/main",
  lastCommitSubject: null,
  concurrentSessions: [],
};

const connection: ConnectionKey = { type: "local" };

function renderCard(overrides: Record<string, unknown> = {}) {
  return render(
    <OverviewPanel
      subagentItems={[]}
      canvasCount={0}
      changedFilesCount={12}
      taskId={null}
      onNavigate={() => {}}
      diffStats={{ insertions: 240, deletions: 58 }}
      uncommittedFilesCount={0}
      scope="session"
      connection={connection}
      ship={ship}
      {...overrides}
    />,
  );
}

describe("OverviewPanel — Changes card", () => {
  it("names the anchor and splits committed from uncommitted", () => {
    renderCard({ uncommittedFilesCount: 3 });

    // "12 files modified" said nothing about where the count was measured from, so committing
    // looked like it had done nothing at all.
    expect(screen.getByText("12 files since session start")).toBeTruthy();
    expect(screen.getByText("9 committed · 3 uncommitted")).toBeTruthy();
  });

  it("shows the work as fully committed once nothing is outstanding", () => {
    renderCard({ uncommittedFilesCount: 0 });

    expect(screen.getByText("12 files since session start")).toBeTruthy();
    expect(screen.getByText("12 committed · 0 uncommitted")).toBeTruthy();
  });

  it("says so when the count covers uncommitted work only", () => {
    // The session's start commit was orphaned by a rebase, amend or reset.
    renderCard({ scope: "uncommitted", changedFilesCount: 3, uncommittedFilesCount: 3 });

    expect(screen.getByText("3 uncommitted files")).toBeTruthy();
    expect(screen.queryByText(/committed ·/)).toBeNull();
  });

  it("reports an unreadable diff instead of a number", () => {
    renderCard({ statsUnavailable: true, changedFilesCount: 0 });

    // The card stays on screen: hiding it is indistinguishable from a session that changed nothing.
    expect(screen.getByText("Changes unavailable")).toBeTruthy();
    expect(screen.queryByText(/insertions/)).toBeNull();
  });

  it("hides itself when the session genuinely changed nothing", () => {
    renderCard({ changedFilesCount: 0, diffStats: null, uncommittedFilesCount: 0 });

    expect(screen.queryByText("Changes")).toBeNull();
  });

  it("never shows a negative committed count when the two polls land out of step", () => {
    renderCard({ changedFilesCount: 2, uncommittedFilesCount: 5 });

    expect(screen.getByText("0 committed · 5 uncommitted")).toBeTruthy();
  });

  /**
   * Work that has merged has nothing left to ship, so the card carries no action row at all — the
   * pull request card beside it already says `Merged #336`. The numbers stay: they are measured
   * from the session's start commit and remain true after the merge.
   */
  it("drops the action row once the work has landed, keeping the numbers", () => {
    renderCard({
      ship: { ...ship, action: "none" },
      onSeedPrompt: () => {},
    });

    expect(screen.queryByText("Commit and push")).toBeNull();
    expect(screen.queryByText("Open pull request")).toBeNull();
    expect(screen.getByText("12 files since session start")).toBeTruthy();
    expect(screen.getByText("+240 insertions")).toBeTruthy();
    expect(screen.getByText("−58 deletions")).toBeTruthy();
  });

  /** The control: the same card with work still to ship does render its one action. */
  it("still offers the action when there is something left to ship", () => {
    renderCard({ onSeedPrompt: () => {} });

    expect(screen.getByText("Open pull request")).toBeTruthy();
  });
});

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { PullRequestCheckInfo } from "@/types/bindings";

vi.mock("@/services/task.service", () => ({
  useTaskAttachmentsQuery: () => ({ data: [] }),
  useTasksQuery: () => ({ data: [] }),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const { CheckRollup } = await import("./OverviewPanel");

function check(name: string, status: PullRequestCheckInfo["status"]): PullRequestCheckInfo {
  return { name, status };
}

describe("CheckRollup", () => {
  /// The card previously said "checks running" in the header and "checks running" again in the
  /// body. The rollup replaces the second copy with something the header does not already say.
  it("counts every state instead of repeating the verdict", () => {
    render(
      <CheckRollup
        ci="Failing"
        checks={[
          check("build (windows)", "Failed"),
          check("e2e", "Running"),
          check("cargo test", "Passed"),
          check("vitest", "Passed"),
        ]}
      />,
    );
    expect(screen.getByText("1 failing · 1 running · 2 passed")).toBeInTheDocument();
  });

  /// A green check is worth exactly the number that already counts it; listing eight of them
  /// pushes the fix-round line and the action off the card.
  it("names only the checks that are not passing", () => {
    render(
      <CheckRollup
        ci="Failing"
        checks={[check("build", "Failed"), check("lint", "Passed"), check("e2e", "Running")]}
      />,
    );
    expect(screen.getByText("build")).toBeInTheDocument();
    expect(screen.getByText("e2e")).toBeInTheDocument();
    expect(screen.queryByText("lint")).not.toBeInTheDocument();
  });

  /// A long red matrix would otherwise make this card several times taller than its neighbours.
  it("caps the named rows and says how many it hid", () => {
    render(
      <CheckRollup
        ci="Failing"
        checks={[
          check("a", "Failed"),
          check("b", "Failed"),
          check("c", "Failed"),
          check("d", "Failed"),
          check("e", "Failed"),
          check("f", "Failed"),
        ]}
      />,
    );
    expect(screen.getByText("6 failing")).toBeInTheDocument();
    expect(screen.getByText("+2 more")).toBeInTheDocument();
    expect(screen.queryByText("f")).not.toBeInTheDocument();
  });

  /// Gitea and Forgejo enumerate nothing. An empty rows block under a red badge reads as a bug
  /// rather than as the forge declining to answer, so the bare verdict stands in.
  it("falls back to the verdict when the forge names no checks", () => {
    render(<CheckRollup ci="Pending" checks={[]} />);
    expect(screen.getByText("checks running")).toBeInTheDocument();
  });

  /// All green is the one case with nothing to name, and the count alone is the whole answer.
  it("shows only the count when everything passed", () => {
    render(
      <CheckRollup ci="Passing" checks={[check("build", "Passed"), check("e2e", "Passed")]} />,
    );
    expect(screen.getByText("2 passed")).toBeInTheDocument();
  });
});

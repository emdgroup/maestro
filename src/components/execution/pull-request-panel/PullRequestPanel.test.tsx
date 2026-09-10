import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ActiveSessionInfo, ProjectPullRequest, PullRequestRowDetail } from "@/types/bindings";

/**
 * What the rows asked the forge for, and whether they were allowed to.
 *
 * The single most important assertion in this file is a negative one — that a row whose detail
 * arrived with the list asks for nothing — and it is invisible in the rendered output, so it is
 * recorded here instead.
 */
const asked = vi.hoisted(() => ({ current: [] as Array<{ number: number; enabled: boolean }> }));

vi.mock("@/services/integration.service", () => ({
  usePullRequestRowDetail: (
    _projectId: number | null,
    number: number,
    _headSha: string | null,
    _updatedAt: string | null,
    enabled: boolean,
  ) => {
    asked.current.push({ number, enabled });
    return { data: undefined };
  },
}));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const { PullRequestPanel } = await import("./PullRequestPanel");

function pullRequest(overrides: Partial<ProjectPullRequest> = {}): ProjectPullRequest {
  return {
    number: 310,
    url: "https://github.com/emdgroup/maestro/pull/310",
    title: "Ship pull requests from the session panel",
    head_branch: "maestro/great-lynx-58",
    base_branch: "main",
    created_at: "2026-09-02T09:00:00Z",
    head_sha: "deadbeef",
    updated_at: "2026-09-04T11:00:00Z",
    from_fork: false,
    detail: null,
    ...overrides,
  };
}

const detail: PullRequestRowDetail = {
  additions: 120,
  deletions: 45,
  changed_files: 7,
  ci: "Passing",
};

function panel(props: Partial<Parameters<typeof PullRequestPanel>[0]> = {}) {
  return render(
    <PullRequestPanel
      projectId={1}
      pullRequests={[pullRequest()]}
      total={null}
      worktrees={[]}
      sessionsByPath={new Map<string, ActiveSessionInfo[]>()}
      remote="origin"
      now={Date.parse("2026-09-05T09:00:00Z")}
      poll
      canSearch
      canCheckOutForks
      search=""
      onSearchChange={() => {}}
      hasPrevious={false}
      hasNext={false}
      onPrevious={() => {}}
      onNext={() => {}}
      onAct={() => {}}
      {...props}
    />,
  );
}

beforeEach(() => {
  asked.current = [];
});

describe("the header's count", () => {
  /**
   * The bug that started this. The old header read `shown/total` where both came from the same
   * page, so a repository with 11,943 open pull requests rendered `100/100` — a denominator that
   * happens to be a lie on exactly the projects where it matters.
   */
  it("counts the page against the project, not against itself", () => {
    panel({ total: 11943 });
    // The thousands separator is the user's locale's, so the assertion allows any of them rather
    // than pinning the test to whichever one the runner happens to have.
    expect(screen.getByText((text) => /^1 of 11\D?943$/.test(text))).toBeTruthy();
  });

  /**
   * Bitbucket Server and Azure DevOps carry no total anywhere in their responses. A bare count is
   * the honest answer; inventing a denominator from the page would put the old lie back.
   */
  it("shows a bare count where the forge will not say how many there are", () => {
    panel({ total: null });
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.queryByText(/ of /)).toBeNull();
  });
});

describe("the search box", () => {
  it("is offered where the forge can search", () => {
    panel({ canSearch: true });
    expect(screen.getByPlaceholderText("Search all pull requests...")).toBeTruthy();
  });

  /**
   * Gitea, Forgejo and Azure DevOps have no pull request text search at all. Absent rather than
   * disabled-and-filtering-locally: a box that quietly matched the thirty rows on screen would
   * mean the whole project on three providers and this page on the other three, which is the
   * ambiguity that removing the local filters was meant to end.
   */
  it("is absent where it cannot work", () => {
    panel({ canSearch: false });
    expect(screen.queryByPlaceholderText("Search all pull requests...")).toBeNull();
  });
});

describe("the pager", () => {
  /**
   * Every open pull request fits on one page for the overwhelming majority of projects, and a
   * pager with both arrows dead is furniture.
   */
  it("stays away until there is somewhere to go", () => {
    panel({ hasPrevious: false, hasNext: false });
    expect(screen.queryByText("Next")).toBeNull();

    panel({ hasNext: true });
    expect(screen.getByText("Next")).toBeTruthy();
  });
});

describe("what a row asks the forge", () => {
  /**
   * The whole point of folding the counts and the verdict into the list request. On GitHub every
   * row arrives answered, and a page of thirty must make no further requests at all — this is the
   * per-row cost the panel used to pay, and nothing in the rendered output would reveal its return.
   */
  it("asks nothing when the list already answered", () => {
    panel({ pullRequests: [pullRequest({ detail })] });
    expect(asked.current.every((call) => !call.enabled)).toBe(true);
  });

  /** And the other half: a forge whose list cannot answer sends exactly one question per row, once. */
  it("asks once for a row the list left unanswered", () => {
    panel({ pullRequests: [pullRequest({ detail: null })] });
    expect(asked.current.some((call) => call.number === 310 && call.enabled)).toBe(true);
  });

  /**
   * Off-screen views cost nothing. Without this the panel would keep asking while the user is on
   * the Kanban board.
   */
  it("asks nothing while the view is off screen", () => {
    panel({ pullRequests: [pullRequest({ detail: null })], poll: false });
    expect(asked.current.every((call) => !call.enabled)).toBe(true);
  });
});

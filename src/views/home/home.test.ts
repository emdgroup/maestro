import { describe, it, expect } from "vitest";
import type { HomeProject } from "@/types/bindings";
import { deriveRepoName } from "./AddProjectDialog";

import { displayPath, projectStatus } from "./ProjectTile";
import { toCard } from "./useHomeSummaries";

const project: HomeProject = {
  project_id: 3,
  path: "/home/billy/src/billing",
  name: "billing",
  queued: 2,
  in_progress: 1,
  review: 1,
  working_agents: 1,
  needs_you: 0,
  blocking_prompt: null,
  running_automations: [],
  lock_holder: "WS-7F2",
  lock_yours: false,
};

describe("toCard", () => {
  it("names the holder only when another window has the project", () => {
    expect(toCard(project).holder).toBe("WS-7F2");
    expect(toCard({ ...project, lock_yours: true }).holder).toBeNull();
  });

  it("turns a count of waiting items into needs you", () => {
    expect(toCard(project).needsYou).toBe(false);
    expect(toCard({ ...project, needs_you: 2 }).needsYou).toBe(true);
  });
});

describe("projectStatus", () => {
  it("ranks needs you above working above idle above quiet", () => {
    const card = toCard(project);
    expect(projectStatus({ ...card, needsYou: true }).label).toBe("Needs you");
    expect(projectStatus(card).label).toBe("Working");
    expect(projectStatus({ ...card, working: 0 }).label).toBe("Idle");
    expect(projectStatus({ ...card, working: 0, queued: 0, review: 0 }).label).toBe("Quiet");
  });
});

describe("displayPath", () => {
  it("shortens the home folder on either platform", () => {
    expect(displayPath("/home/billy/src/x")).toBe("~/src/x");
    expect(displayPath("C:\\Users\\billy\\src\\x")).toBe("~\\src\\x");
    expect(displayPath("C:/Users/billy/maestro-demo")).toBe("~/maestro-demo");
    expect(displayPath("/data/x")).toBe("/data/x");
  });
});

describe("deriveRepoName", () => {
  it("takes the last path segment without .git", () => {
    expect(deriveRepoName("https://github.com/owner/repo.git")).toBe("repo");
    expect(deriveRepoName("git@gitlab.com:group/sub/tool/")).toBe("tool");
  });
});

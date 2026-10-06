import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Project } from "@/types/bindings";
import { TooltipProvider } from "@/ui/tooltip";
import { useHomeStore } from "@/store/homeStore";
import type { ProjectCard } from "@/views/home/ProjectTile";
import { ProjectPath } from "./ProjectPath";

const openProject = vi.hoisted(() => vi.fn());
const clearSelectedProject = vi.hoisted(() => vi.fn());
const slideOut = vi.hoisted(() => vi.fn());

vi.mock("@/components/layout/project-transition/projectTransition", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  slideOut,
}));

vi.mock("@/store/projectStore", () => ({
  useSelectedProjectActions: () => ({ clearSelectedProject }),
}));
vi.mock("@/views/home/useOpenProject", () => ({
  useOpenProject: () => ({ openProject, openPath: vi.fn(), opening: null, dialogs: null }),
}));
vi.mock("@/views/home/AddProjectDialog", () => ({ AddProjectDialog: () => null }));
vi.mock("@/views/home/ssh-auth-modal/SshAuthModal", () => ({ SshAuthModal: () => null }));
vi.mock("@/views/home/useHomeConnections", () => ({
  useHomeConnections: () => [
    { key: { type: "local" }, id: "local", name: "This computer", detail: "" },
    { key: { type: "ssh", id: 4 }, id: "ssh:4", name: "devbox", detail: "billy@devbox" },
    { key: { type: "ssh", id: 5 }, id: "ssh:5", name: "gpu-runner-02", detail: "ml@gpu" },
  ],
}));

const card = (projectId: number, name: string, extra: Partial<ProjectCard> = {}): ProjectCard => ({
  projectId,
  path: `/src/${name}`,
  name,
  working: 0,
  review: 0,
  queued: 0,
  needsYou: false,
  blockingPrompt: null,
  runningAutomation: null,
  holder: null,
  ...extra,
});

vi.mock("@/views/home/useHomeSummaries", () => ({
  useHomeSummaries: () =>
    new Map([
      ["local", { projects: [card(1, "maestro"), card(2, "scratch")] }],
      [
        "ssh:4",
        {
          projects: [
            card(11, "api-gateway", { working: 2 }),
            card(12, "billing", { needsYou: true, blockingPrompt: "Run a migration?" }),
          ],
        },
      ],
    ]),
}));

const project = { id: 1, name: "maestro", path: "/src/maestro", connection_id: null } as Project;

function renderPath() {
  return render(
    <TooltipProvider>
      <ProjectPath project={project} />
    </TooltipProvider>,
  );
}

describe("ProjectPath", () => {
  beforeEach(() => {
    openProject.mockReset();
    slideOut.mockReset();
    clearSelectedProject.mockReset();
    useHomeStore.setState({
      phases: { local: { kind: "up" }, "ssh:4": { kind: "up" } },
      hidden: ["local|/src/scratch"],
    });
  });

  it("goes Home from the house, which names the project that needs you", () => {
    renderPath();
    fireEvent.click(screen.getByRole("button", { name: "Home · billing needs you" }));
    expect(clearSelectedProject).toHaveBeenCalled();
  });

  it("opens a project on another connection from the connection's side panel", async () => {
    renderPath();
    fireEvent.click(screen.getByText("This computer"));
    fireEvent.click(await screen.findByText("devbox"));
    fireEvent.click(await screen.findByText("billing"));
    expect(openProject).toHaveBeenCalledWith(12);
    // devbox comes after This computer in the menu, so the view slides up.
    expect(slideOut).toHaveBeenCalledWith(1);
  });

  it("offers Connect for a connection that is not connected", async () => {
    renderPath();
    fireEvent.click(screen.getByText("This computer"));
    fireEvent.click(await screen.findByText("gpu-runner-02"));
    expect(await screen.findByText("Connect")).toBeTruthy();
  });

  it("lists this connection's projects, without the ones removed from Home", async () => {
    renderPath();
    fireEvent.click(screen.getByText("maestro"));
    expect(await screen.findByText("Add project")).toBeTruthy();
    expect(screen.queryByText("scratch")).toBeNull();
    expect(screen.getAllByText("maestro")).toHaveLength(2);
  });

  it("slides down to a project higher in the list", async () => {
    render(
      <TooltipProvider>
        <ProjectPath project={{ ...project, id: 12, name: "billing", connection_id: 4 }} />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByText("devbox"));
    fireEvent.click(await screen.findByText("This computer"));
    fireEvent.click(await screen.findByText("maestro"));
    expect(slideOut).toHaveBeenCalledWith(-1);
    expect(openProject).toHaveBeenCalledWith(1);
  });
});

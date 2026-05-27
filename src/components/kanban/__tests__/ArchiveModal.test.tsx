import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ArchiveModal } from "../ArchiveModal";

const mockSetActiveTaskId = vi.fn();

vi.mock("@/services/task.service", () => ({
  useTasksQuery: vi.fn(() => ({
    data: [
      {
        id: 1,
        title: "Completed task",
        status: "Done",
        priority: "Medium",
        labels: [],
        archived_at: "2026-05-01T00:00:00Z",
        updated_at: "2026-05-01T00:00:00Z",
      },
      {
        id: 2,
        title: "Cancelled task",
        status: "Cancelled",
        priority: "Low",
        labels: [],
        archived_at: null,
        updated_at: "2026-05-02T00:00:00Z",
      },
    ],
    isLoading: false,
  })),
}));

vi.mock("@/store/navigationStore", () => ({
  useNavigationActions: vi.fn(() => ({
    setActiveTaskId: mockSetActiveTaskId,
  })),
}));

describe("ArchiveModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders task list when isOpen=true", () => {
    render(<ArchiveModal isOpen={true} onClose={vi.fn()} projectId={1} />);
    expect(screen.getByText("Completed task")).toBeInTheDocument();
    expect(screen.getByText("Cancelled task")).toBeInTheDocument();
  });

  it("filters tasks by search input value", () => {
    render(<ArchiveModal isOpen={true} onClose={vi.fn()} projectId={1} />);
    fireEvent.change(screen.getByPlaceholderText("Search archived tasks..."), {
      target: { value: "Completed" },
    });
    expect(screen.getByText("Completed task")).toBeInTheDocument();
    expect(screen.queryByText("Cancelled task")).not.toBeInTheDocument();
  });

  it("shows only Done tasks when Done tab selected", () => {
    render(<ArchiveModal isOpen={true} onClose={vi.fn()} projectId={1} />);
    fireEvent.click(screen.getByRole("tab", { name: "Done" }));
    expect(screen.getByText("Completed task")).toBeInTheDocument();
    expect(screen.queryByText("Cancelled task")).not.toBeInTheDocument();
  });

  it("shows only Cancelled tasks when Cancelled tab selected", () => {
    render(<ArchiveModal isOpen={true} onClose={vi.fn()} projectId={1} />);
    fireEvent.click(screen.getByRole("tab", { name: "Cancelled" }));
    expect(screen.getByText("Cancelled task")).toBeInTheDocument();
    expect(screen.queryByText("Completed task")).not.toBeInTheDocument();
  });

  it("calls setActiveTaskId and onClose when a task row is clicked", () => {
    const onClose = vi.fn();
    render(<ArchiveModal isOpen={true} onClose={onClose} projectId={1} />);
    fireEvent.click(screen.getByText("Completed task").closest("button")!);
    expect(mockSetActiveTaskId).toHaveBeenCalledWith(1);
    expect(onClose).toHaveBeenCalled();
  });
});

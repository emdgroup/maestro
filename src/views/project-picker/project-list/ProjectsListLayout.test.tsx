import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProjectsListLayout } from "./ProjectsListLayout";

const defaultProps = {
  headerContent: <div>Header</div>,
  children: <div>Content</div>,
  onBack: vi.fn(),
  onSelectNewClick: vi.fn(),
  onCloneClick: vi.fn(),
  onCreateClick: vi.fn(),
  loading: false,
};

describe("ProjectsListLayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders three footer buttons: Select Project, Clone Repository, Create Project", () => {
    render(<ProjectsListLayout {...defaultProps} />);
    expect(screen.getByText("Select Project")).toBeInTheDocument();
    expect(screen.getByText("Clone Repository")).toBeInTheDocument();
    expect(screen.getByText("Create Project")).toBeInTheDocument();
  });

  it("disables all buttons when loading", () => {
    render(<ProjectsListLayout {...defaultProps} loading={true} />);
    expect(screen.getByText("Select Project").closest("button")).toBeDisabled();
    expect(screen.getByText("Clone Repository").closest("button")).toBeDisabled();
    expect(screen.getByText("Create Project").closest("button")).toBeDisabled();
  });

  it("calls onCloneClick when Clone Repository button clicked", () => {
    render(<ProjectsListLayout {...defaultProps} />);
    screen.getByText("Clone Repository").click();
    expect(defaultProps.onCloneClick).toHaveBeenCalled();
  });

  it("calls onCreateClick when Create Project button clicked", () => {
    render(<ProjectsListLayout {...defaultProps} />);
    screen.getByText("Create Project").click();
    expect(defaultProps.onCreateClick).toHaveBeenCalled();
  });

  it("calls onSelectNewClick when Select Project button clicked", () => {
    render(<ProjectsListLayout {...defaultProps} />);
    screen.getByText("Select Project").click();
    expect(defaultProps.onSelectNewClick).toHaveBeenCalled();
  });
});

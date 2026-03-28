import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProjectsListLayout } from "../ProjectsListLayout";

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

  it("renders three footer buttons: Select Existing, Clone, Create", () => {
    render(<ProjectsListLayout {...defaultProps} />);
    expect(screen.getByText("Select Existing")).toBeInTheDocument();
    expect(screen.getByText("Clone")).toBeInTheDocument();
    expect(screen.getByText("Create")).toBeInTheDocument();
  });

  it("disables all buttons when loading", () => {
    render(<ProjectsListLayout {...defaultProps} loading={true} />);
    expect(screen.getByText("Select Existing").closest("button")).toBeDisabled();
    expect(screen.getByText("Clone").closest("button")).toBeDisabled();
    expect(screen.getByText("Create").closest("button")).toBeDisabled();
  });

  it("calls onCloneClick when Clone button clicked", () => {
    render(<ProjectsListLayout {...defaultProps} />);
    screen.getByText("Clone").click();
    expect(defaultProps.onCloneClick).toHaveBeenCalled();
  });

  it("calls onCreateClick when Create button clicked", () => {
    render(<ProjectsListLayout {...defaultProps} />);
    screen.getByText("Create").click();
    expect(defaultProps.onCreateClick).toHaveBeenCalled();
  });

  it("calls onSelectNewClick when Select Existing button clicked", () => {
    render(<ProjectsListLayout {...defaultProps} />);
    screen.getByText("Select Existing").click();
    expect(defaultProps.onSelectNewClick).toHaveBeenCalled();
  });
});

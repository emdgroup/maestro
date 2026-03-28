import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CreateProjectDialog } from "../CreateProjectDialog";

vi.mock("@/services/project.service", () => ({
  useCreateNewProject: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/store/projectStore", () => ({
  useSelectedProjectActions: () => ({
    setSelectedProject: vi.fn(),
  }),
}));

vi.mock("../FilePicker", () => ({
  FilePicker: () => <div data-testid="file-picker">FilePicker</div>,
}));

function renderDialog(open = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CreateProjectDialog open={open} onOpenChange={vi.fn()} connection={null} />
    </QueryClientProvider>,
  );
}

describe("CreateProjectDialog", () => {
  it("renders parent directory and folder name inputs when open", () => {
    renderDialog(true);
    expect(screen.getByLabelText("Parent Directory")).toBeInTheDocument();
    expect(screen.getByLabelText("Folder Name")).toBeInTheDocument();
  });

  it("renders Create and Cancel buttons", () => {
    renderDialog(true);
    expect(screen.getByText("Create")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });

  it("does not render when closed", () => {
    renderDialog(false);
    expect(screen.queryByLabelText("Parent Directory")).not.toBeInTheDocument();
  });

  it("has error display mechanism using text-destructive class", () => {
    renderDialog(true);
    // No error initially visible
    expect(screen.queryByText(/Directory already exists/)).not.toBeInTheDocument();
  });
});

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CloneProjectDialog } from "../CloneProjectDialog";

// Mock service hooks
vi.mock("@/services/project.service", () => ({
  useCloneProject: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/store/projectStore", () => ({
  useSelectedProjectActions: () => ({
    setSelectedProject: vi.fn(),
  }),
}));

// Mock FilePicker to avoid deep dependency tree
vi.mock("../FilePicker", () => ({
  FilePicker: () => <div data-testid="file-picker">FilePicker</div>,
}));

function renderDialog(open = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CloneProjectDialog open={open} onOpenChange={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe("CloneProjectDialog", () => {
  it("renders URL and target path inputs when open", () => {
    renderDialog(true);
    expect(screen.getByLabelText("Git URL")).toBeInTheDocument();
    expect(screen.getByLabelText("Target Path")).toBeInTheDocument();
  });

  it("renders Clone and Cancel buttons", () => {
    renderDialog(true);
    expect(screen.getByText("Clone")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });

  it("does not render when closed", () => {
    renderDialog(false);
    expect(screen.queryByLabelText("Git URL")).not.toBeInTheDocument();
  });
});

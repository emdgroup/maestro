import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CloneProjectDialog } from "./CloneProjectDialog";

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

vi.mock("../FilePicker", () => ({
  FilePicker: () => <div data-testid="file-picker">FilePicker</div>,
}));

vi.mock("../provider-repo-picker/ProviderRepoPicker", () => ({
  ProviderRepoPicker: () => <div data-testid="provider-repo-picker">ProviderRepoPicker</div>,
}));

function renderDialog(open = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CloneProjectDialog open={open} onOpenChange={vi.fn()} connection={null} />
    </QueryClientProvider>,
  );
}

describe("CloneProjectDialog", () => {
  it("renders Parent Directory input and Provider tab by default", () => {
    renderDialog(true);
    expect(screen.getByLabelText(/Parent Directory/)).toBeInTheDocument();
    expect(screen.getByTestId("provider-repo-picker")).toBeInTheDocument();
  });

  it("shows Git URL input when URL tab clicked", async () => {
    renderDialog(true);
    await userEvent.click(screen.getByRole("tab", { name: /URL/i }));
    expect(screen.getByLabelText(/Git URL/)).toBeInTheDocument();
  });

  it("renders Clone and Cancel buttons", () => {
    renderDialog(true);
    expect(screen.getByText("Clone")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });

  it("does not render when closed", () => {
    renderDialog(false);
    expect(screen.queryByLabelText(/Parent Directory/)).not.toBeInTheDocument();
  });
});

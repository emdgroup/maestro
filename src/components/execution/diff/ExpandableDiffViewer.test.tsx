import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DiffModeEnum } from "@git-diff-view/react";
import type { DiffFileWithName } from "@/types/review";

const getFileContentAtBase = vi.fn();

vi.mock("@/lib/tauri-utils", () => ({
  api: { getFileContentAtBase: (...args: unknown[]) => getFileContentAtBase(...args) },
}));

// The real viewer pulls in Shiki and the library's DOM. What matters here is which `diffFile` it
// was handed and whether it was given a way to ask for context at all.
vi.mock("./DiffViewer", () => ({
  DiffViewer: ({
    diffFile,
    onRequestContext,
  }: {
    diffFile: DiffFileWithName;
    onRequestContext?: () => void;
  }) => (
    <div data-testid="diff-viewer">
      <span data-testid="old-content">{diffFile.oldFile?.content ?? "none"}</span>
      <span data-testid="old-name">{diffFile.oldFile?.fileName ?? "none"}</span>
      {onRequestContext ? (
        <button onClick={onRequestContext}>request context</button>
      ) : (
        <span data-testid="inert" />
      )}
    </div>
  ),
}));

import { ExpandableDiffViewer } from "./ExpandableDiffViewer";

const PRE_IMAGE = "line 1\nline 2\nline 3\n";

function modifiedFile(overrides: Partial<DiffFileWithName> = {}): DiffFileWithName {
  return {
    fileName: "src/a.ts",
    oldPath: "src/a.ts",
    status: "M",
    newFile: { fileName: "src/a.ts", fileLang: "typescript", content: "" },
    hunks: ["@@ -1 +1 @@\n-old\n+new"],
    ...overrides,
  };
}

function renderViewer(file: DiffFileWithName) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ExpandableDiffViewer
        file={file}
        projectId={1}
        cwd="/tmp/wt"
        diffTarget={{ type: "Head" }}
        diffViewMode={DiffModeEnum.Unified}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getFileContentAtBase.mockReset();
  getFileContentAtBase.mockResolvedValue(PRE_IMAGE);
});

describe("ExpandableDiffViewer", () => {
  // The whole point of the lazy fetch: mounting a card must cost exactly what it costs today.
  it("fetches nothing until the context is asked for", () => {
    renderViewer(modifiedFile());
    expect(getFileContentAtBase).not.toHaveBeenCalled();
    expect(screen.getByTestId("old-content")).toHaveTextContent("none");
  });

  it("attaches the pre-image once the context is requested", async () => {
    const user = userEvent.setup();
    renderViewer(modifiedFile());

    await user.click(screen.getByRole("button", { name: "request context" }));

    await waitFor(() => expect(screen.getByTestId("old-content")).toHaveTextContent("line 1"));
    expect(getFileContentAtBase).toHaveBeenCalledOnce();
    expect(getFileContentAtBase).toHaveBeenCalledWith(1, "/tmp/wt", { type: "Head" }, "src/a.ts");
  });

  // Once content is in, the library renders its own real arrows in that cell — leaving ours bound
  // would layer a second click target over them.
  it("stops offering the request once the content has arrived", async () => {
    const user = userEvent.setup();
    renderViewer(modifiedFile());

    await user.click(screen.getByRole("button", { name: "request context" }));

    await waitFor(() => expect(screen.getByTestId("inert")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "request context" })).toBeNull();
  });

  // A rename's pre-image lives under the old name; asking for the new one would miss.
  it("reads a renamed file's pre-image from its old path", async () => {
    const user = userEvent.setup();
    renderViewer(modifiedFile({ fileName: "src/new.ts", oldPath: "src/old.ts" }));

    await user.click(screen.getByRole("button", { name: "request context" }));

    await waitFor(() => expect(getFileContentAtBase).toHaveBeenCalled());
    expect(getFileContentAtBase).toHaveBeenCalledWith(1, "/tmp/wt", { type: "Head" }, "src/old.ts");
    expect(screen.getByTestId("old-name")).toHaveTextContent("src/old.ts");
  });

  // An added file has no pre-image and its diff already shows every line, so the header must be
  // inert rather than clickable and silently useless.
  it("offers nothing for a file the base does not have", () => {
    renderViewer(modifiedFile({ status: "A", oldPath: undefined }));

    expect(screen.getByTestId("inert")).toBeInTheDocument();
    expect(getFileContentAtBase).not.toHaveBeenCalled();
  });

  // A blob past the size cap comes back as null, and the diff has to stay readable.
  it("keeps rendering the diff when there is no fetchable pre-image", async () => {
    getFileContentAtBase.mockResolvedValue(null);
    const user = userEvent.setup();
    renderViewer(modifiedFile());

    await user.click(screen.getByRole("button", { name: "request context" }));

    await waitFor(() => expect(getFileContentAtBase).toHaveBeenCalled());
    expect(screen.getByTestId("diff-viewer")).toBeInTheDocument();
    expect(screen.getByTestId("old-content")).toHaveTextContent("none");
  });
});

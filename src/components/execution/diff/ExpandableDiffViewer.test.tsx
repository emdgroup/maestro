import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DiffModeEnum } from "@git-diff-view/react";
import type { DiffFileWithName } from "@/types/review";

const getFileContentAtBase = vi.fn();

vi.mock("@/lib/tauri-utils", () => ({
  api: { getFileContentAtBase: (...args: unknown[]) => getFileContentAtBase(...args) },
}));

// The real viewer pulls in the highlighter and the library's DOM. What matters here is which
// `diffFile` it was handed and whether it was told to colour it.
vi.mock("./DiffViewer", () => ({
  DiffViewer: ({ diffFile, highlight }: { diffFile: DiffFileWithName; highlight?: boolean }) => (
    <div data-testid="diff-viewer" data-highlight={String(highlight)}>
      <span data-testid="old-content">{diffFile.oldFile?.content ?? "none"}</span>
      <span data-testid="old-name">{diffFile.oldFile?.fileName ?? "none"}</span>
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

function renderViewer(file: DiffFileWithName, highlight = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ExpandableDiffViewer
        file={file}
        projectId={1}
        cwd="/tmp/wt"
        diffTarget={{ type: "Head" }}
        diffViewMode={DiffModeEnum.Unified}
        highlight={highlight}
      />
    </QueryClientProvider>,
  );
}

const viewer = () => screen.getByTestId("diff-viewer");

beforeEach(() => {
  getFileContentAtBase.mockReset();
  getFileContentAtBase.mockResolvedValue(PRE_IMAGE);
});

describe("ExpandableDiffViewer", () => {
  // A card the stack has not coloured yet is off screen: it costs no IPC until it is looked at.
  it("fetches nothing until the card is highlighted", () => {
    renderViewer(modifiedFile(), false);
    expect(getFileContentAtBase).not.toHaveBeenCalled();
    expect(screen.getByTestId("old-content")).toHaveTextContent("none");
  });

  // Colouring the diff lines alone miscolours any hunk that opens inside a comment or a template
  // literal, so the colour waits for the file it belongs to.
  it("fetches the pre-image once highlighted, and colours only after it arrives", async () => {
    let resolve!: (content: string) => void;
    getFileContentAtBase.mockReturnValue(new Promise((r) => (resolve = r)));
    renderViewer(modifiedFile());

    await waitFor(() => expect(getFileContentAtBase).toHaveBeenCalledOnce());
    expect(getFileContentAtBase).toHaveBeenCalledWith(1, "/tmp/wt", { type: "Head" }, "src/a.ts");
    expect(viewer()).toHaveAttribute("data-highlight", "false");

    resolve(PRE_IMAGE);
    await waitFor(() => expect(screen.getByTestId("old-content")).toHaveTextContent("line 1"));
    expect(viewer()).toHaveAttribute("data-highlight", "true");
  });

  // A rename's pre-image lives under the old name; asking for the new one would miss.
  it("reads a renamed file's pre-image from its old path", async () => {
    renderViewer(modifiedFile({ fileName: "src/new.ts", oldPath: "src/old.ts" }));

    await waitFor(() => expect(screen.getByTestId("old-name")).toHaveTextContent("src/old.ts"));
    expect(getFileContentAtBase).toHaveBeenCalledWith(1, "/tmp/wt", { type: "Head" }, "src/old.ts");
  });

  // An added file has no pre-image, and its diff already shows every line.
  it("colours an added file at once, having nothing to fetch", () => {
    renderViewer(modifiedFile({ status: "A", oldPath: undefined }));

    expect(viewer()).toHaveAttribute("data-highlight", "true");
    expect(getFileContentAtBase).not.toHaveBeenCalled();
  });

  // A blob past the size cap comes back as null, and the diff has to stay readable.
  it("colours the diff lines alone when the pre-image comes back empty", async () => {
    getFileContentAtBase.mockResolvedValue(null);
    renderViewer(modifiedFile());

    await waitFor(() => expect(viewer()).toHaveAttribute("data-highlight", "true"));
    expect(screen.getByTestId("old-content")).toHaveTextContent("none");
  });

  it("colours the diff lines alone when the pre-image cannot be had", async () => {
    getFileContentAtBase.mockRejectedValue(new Error("gone"));
    renderViewer(modifiedFile());

    await waitFor(() => expect(viewer()).toHaveAttribute("data-highlight", "true"));
    expect(screen.getByTestId("old-content")).toHaveTextContent("none");
  });
});

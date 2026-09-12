import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { UntrackedFileDiffViewer } from "./UntrackedFileDiffViewer";

const untrackedContent = vi.fn();
const binaryInfo = vi.fn();

vi.mock("@/services/worktree.service", () => ({
  useUntrackedFileContentQuery: (...args: unknown[]) => untrackedContent(...args),
  useBinaryFileInfoQuery: (...args: unknown[]) => binaryInfo(...args),
}));

// Stubbed to a marker: what is under test is which branch this component takes, not what the
// real viewer draws — and the real one wants a ThemeProvider and a shiki instance to say so.
vi.mock("./DiffViewer", () => ({
  DiffViewer: () => <div data-testid="diff-viewer" />,
}));

/** What `git diff --no-index /dev/null <path>` answers with for a binary file: no hunks. */
const BINARY =
  "diff --git a/dev/null b/src/blob.bin\nnew file mode 100644\nindex 0000000..1b2c3d4\nBinary files /dev/null and b/src/blob.bin differ\n";

const TEXT =
  "diff --git a/dev/null b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,1 @@\n+export const a = 1;\n";

function renderFor(data: string | undefined, isLoading = false, filePath = "src/blob.bin") {
  untrackedContent.mockReturnValue({ data, isLoading });
  return render(
    <UntrackedFileDiffViewer
      projectId={1}
      worktreePath="/w"
      filePath={filePath}
      showHeader={false}
    />,
  );
}

beforeEach(() => {
  untrackedContent.mockReset();
  binaryInfo.mockReturnValue({ data: undefined, isLoading: false });
});

describe("UntrackedFileDiffViewer", () => {
  // The empty frame this replaces read as a broken card rather than as "nothing to read here".
  it("explains a binary file instead of rendering an empty diff", () => {
    renderFor(BINARY);
    expect(screen.getByText("Binary file. There is no line-by-line diff to show.")).toBeTruthy();
  });

  // An image is the one binary a reviewer can actually read, so it gets shown rather than described.
  it("shows the image itself for a new picture", () => {
    binaryInfo.mockReturnValue({
      data: { old_size: 0, new_size: 59_699, preview: "AAAA" },
      isLoading: false,
    });
    renderFor(BINARY.replace(/blob\.bin/g, "logo.png"), false, "src/logo.png");
    expect(screen.getByRole("img").getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(screen.getByText("58.3 KB")).toBeTruthy();
    expect(screen.queryByText(/no line-by-line diff/)).toBeNull();
  });

  it("still renders the diff for a file that has one", () => {
    renderFor(TEXT);
    expect(screen.queryByText(/no line-by-line diff/)).toBeNull();
    expect(screen.getByTestId("diff-viewer")).toBeTruthy();
  });

  // The viewer owns the loading state, so handing it over is what keeps the spinner.
  it("defers to the viewer while the content is still loading", () => {
    renderFor(undefined, true);
    expect(screen.queryByText(/no line-by-line diff/)).toBeNull();
    expect(screen.getByTestId("diff-viewer")).toBeTruthy();
  });
});

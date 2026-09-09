import { useEffect } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConnectionKey } from "@/types/bindings";

const readFile = vi.fn();
const writeFile = vi.fn();
const listContents = vi.fn();
const listWorkspaceFiles = vi.fn();
const deleteFile = vi.fn();
const renameFile = vi.fn();
const createFileAt = vi.fn();
const createDirectoryAt = vi.fn();
const getSettings = vi.fn();
const saveSettings = vi.fn();

vi.mock("@/lib/tauri-utils", () => ({
  api: {
    readFile: (...a: unknown[]) => readFile(...a),
    readFileBinary: () => Promise.resolve(""),
    writeFile: (...a: unknown[]) => writeFile(...a),
    listContents: (...a: unknown[]) => listContents(...a),
    listWorkspaceFiles: (...a: unknown[]) => listWorkspaceFiles(...a),
    deleteFile: (...a: unknown[]) => deleteFile(...a),
    renameFile: (...a: unknown[]) => renameFile(...a),
    createFileAt: (...a: unknown[]) => createFileAt(...a),
    createDirectoryAt: (...a: unknown[]) => createDirectoryAt(...a),
    getSettings: (...a: unknown[]) => getSettings(...a),
    saveSettings: (...a: unknown[]) => saveSettings(...a),
  },
}));

vi.mock("@/lib/file-opener", () => ({
  openFileWithConnection: vi.fn(),
  downloadFileToFolder: vi.fn(),
  opensViaHostCopy: () => false,
}));

// Markdown and the mime branches pull in Shiki and react-markdown; none of that is what these
// tests are about.
vi.mock("./WorkspaceFileContent", () => ({
  WorkspaceFileContent: ({ content, fileName }: { content: string | null; fileName: string }) => (
    <div data-testid="read-view">
      {fileName}:{content}
    </div>
  ),
}));

// CodeMirror has its own suite (FileEditor.test.tsx). A textarea gives these tests the same
// contract — a document in, edits and Ctrl+S out — without its measuring machinery.
//
// The same component renders both modes now, so the mock has to as well: read-only stands in for
// what `WorkspaceFileContent` used to show for a plain text file, under the same test id, which is
// what lets the assertions below stay about behaviour rather than about which component won.
let editorMountCount = 0;
vi.mock("./FileEditor", () => ({
  FileEditor: ({
    doc,
    docEpoch,
    fileName,
    readOnly,
    onChange,
    onSave,
  }: {
    doc: string;
    docEpoch: number;
    fileName: string;
    readOnly?: boolean;
    onChange: (v: string) => void;
    onSave: () => void;
  }) => {
    useEffect(() => {
      editorMountCount += 1;
    }, []);
    if (readOnly) {
      return (
        <div data-testid="read-view">
          {fileName}:{doc}
        </div>
      );
    }
    return (
      <div>
        <textarea
          data-testid="editor"
          data-epoch={docEpoch}
          defaultValue={doc}
          key={docEpoch}
          onChange={(e) => onChange(e.target.value)}
        />
        <button onClick={onSave}>editor-save</button>
      </div>
    );
  },
}));

// happy-dom's ResizeObserver never fires, so the panel would never learn a width. This records the
// observed elements and lets a test drive them, which is the only way to exercise the width-based
// collapse without a real layout engine.
//
// Only the panel's own element is ever notified: `ResizablePanelGroup` installs an observer too,
// and handing its callback a stub entry crashes inside the library.
type Observed = { element: Element; notify: (width: number) => void };
const observed = new Set<Observed>();

class TestResizeObserver {
  callback: (entries: Array<{ contentRect: { width: number } }>) => void;
  mine = new Set<Observed>();

  constructor(callback: (entries: Array<{ contentRect: { width: number } }>) => void) {
    this.callback = callback;
  }

  observe(element: Element) {
    const entry: Observed = {
      element,
      notify: (width) => this.callback([{ contentRect: { width } }]),
    };
    this.mine.add(entry);
    observed.add(entry);
  }

  disconnect() {
    for (const entry of this.mine) observed.delete(entry);
    this.mine.clear();
  }

  unobserve() {}
}
vi.stubGlobal("ResizeObserver", TestResizeObserver);

function resizeEditArea(width: number) {
  act(() => {
    for (const { element, notify } of observed) {
      if (element.getAttribute("data-slot") === "markdown-edit-area") notify(width);
    }
  });
}

import { WorkspaceFilesPanel } from "./WorkspaceFilesPanel";

const CONNECTION = { type: "local" } as unknown as ConnectionKey;
const WORKSPACE = "/work/repo";

function renderPanel(props: Partial<Parameters<typeof WorkspaceFilesPanel>[0]> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const utils = render(
    <QueryClientProvider client={client}>
      <WorkspaceFilesPanel
        workspacePath={WORKSPACE}
        connection={CONNECTION}
        initialPath="src/main.ts"
        {...props}
      />
    </QueryClientProvider>,
  );
  return utils;
}

async function enterEditMode() {
  await waitFor(() => expect(screen.getByTestId("read-view")).toHaveTextContent("original"));
  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  await waitFor(() => expect(screen.getByTestId("editor")).toBeInTheDocument());
}

async function typeDraft(text: string) {
  const editor = screen.getByTestId("editor");
  await userEvent.clear(editor);
  await userEvent.type(editor, text);
}

beforeEach(() => {
  vi.clearAllMocks();
  // `useReviewPanelLayout` remembers whether the file list is open, so a test that closes it would
  // otherwise open the next one with it shut.
  localStorage.clear();
  editorMountCount = 0;
  readFile.mockResolvedValue("original");
  writeFile.mockResolvedValue(null);
  listContents.mockResolvedValue([]);
  listWorkspaceFiles.mockResolvedValue([]);
  getSettings.mockResolvedValue({ markdown_edit_layout: null, updated_at: "now" });
  saveSettings.mockResolvedValue(null);
});

describe("WorkspaceFilesPanel edit mode", () => {
  it("shows the file read-only until editing is asked for", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("read-view")).toHaveTextContent("original"));
    expect(screen.queryByTestId("editor")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });

  /// Both modes are the same editor, which is what makes them agree about colour. If the toggle
  /// remounted it, the scroll position would reset on every entry to edit mode and the two views
  /// would be free to drift apart again.
  it("switches into edit mode without remounting the editor", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("read-view")).toHaveTextContent("original"));
    const mountsAfterRead = editorMountCount;
    expect(mountsAfterRead).toBe(1);

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => expect(screen.getByTestId("editor")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.getByTestId("read-view")).toBeInTheDocument());

    expect(editorMountCount).toBe(mountsAfterRead);
  });

  /// The read view renders these through a mime branch and never loads text for them; an editor
  /// would open empty and its save would truncate the real file.
  it("offers no editing for a binary file", async () => {
    renderPanel({ initialPath: "docs/diagram.png" });
    await waitFor(() => expect(screen.getByTestId("read-view")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("writes the draft when the file has not changed underneath", async () => {
    renderPanel();
    await enterEditMode();
    await typeDraft("edited");

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(writeFile).toHaveBeenCalledWith(CONNECTION, `${WORKSPACE}/src/main.ts`, "edited"),
    );
  });

  it("saves from the editor's own Ctrl+S binding", async () => {
    renderPanel();
    await enterEditMode();
    await typeDraft("edited");

    await userEvent.click(screen.getByRole("button", { name: "editor-save" }));

    await waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1));
  });

  it("re-reads before writing, so it is never working from the polled copy", async () => {
    renderPanel();
    await enterEditMode();
    await typeDraft("edited");
    readFile.mockClear();

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(readFile).toHaveBeenCalled());
    expect(writeFile).toHaveBeenCalled();
  });

  /// The agent happened to write exactly what the user typed. Raising a conflict here would ask
  /// them to choose between two identical files.
  it("writes nothing when the draft already matches what is on disk", async () => {
    renderPanel();
    await enterEditMode();
    await typeDraft("agent wrote this");
    readFile.mockResolvedValue("agent wrote this");

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(readFile).toHaveBeenCalled());
    expect(writeFile).not.toHaveBeenCalled();
    expect(screen.queryByText(/changed while you were editing/i)).toBeNull();
  });

  /// `disabled` on a base-ui TooltipTrigger does not reach the DOM, so the button is genuinely
  /// clickable with nothing to save — and a save on a clean buffer would compare a stale baseline
  /// against disk and raise a conflict dialog over an edit that was never made.
  it("does nothing when saving a buffer that was never edited", async () => {
    renderPanel();
    await enterEditMode();
    readFile.mockClear();
    readFile.mockResolvedValue("someone else's rewrite");

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(writeFile).not.toHaveBeenCalled();
    expect(screen.queryByText(/changed while you were editing/i)).toBeNull();
  });

  /// Reported from real use: a floppy-disk icon and a tick gave no answer to "how do I leave
  /// without saving". The controls are icons again, so the answer lives in their names and
  /// tooltips instead — which is what a screen reader and a hover both reach.
  it("names its edit-mode actions, however they are drawn", async () => {
    renderPanel();
    await enterEditMode();

    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  /// "Cancel" was wrong on a clean buffer — nothing was being cancelled. One X now serves both,
  /// and the name follows the buffer so it always says what pressing it will do.
  it("names the exit for what it will do to the buffer", async () => {
    renderPanel();
    await enterEditMode();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();

    await typeDraft("edited");

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  /// Also reported from real use. This is the base-ui gap: `disabled` on a `TooltipTrigger`
  /// becomes `data-trigger-disabled` and never reaches the DOM, so the previous Save button looked
  /// and behaved enabled with nothing to save. A plain `<button>` is what makes this assertion
  /// possible at all.
  it("disables Save until something has actually changed", async () => {
    renderPanel();
    await enterEditMode();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await typeDraft("edited");
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
  });

  it("disables Save again once the draft is written", async () => {
    renderPanel();
    await enterEditMode();
    await typeDraft("edited");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());
  });

  it("surfaces a failed write instead of pretending it saved", async () => {
    renderPanel();
    await enterEditMode();
    await typeDraft("edited");
    writeFile.mockRejectedValue(new Error("Permission denied (os error 13)"));

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByText(/Permission denied/)).toBeInTheDocument());
    // Still dirty, still editing — the user has not lost their work.
    expect(screen.getByTestId("editor")).toBeInTheDocument();
  });

  it("warns while the agent is running, because it may be writing the same file", async () => {
    renderPanel({ isProcessing: true });
    await enterEditMode();
    expect(screen.getByText(/agent is running/i)).toBeInTheDocument();
  });

  it("does not warn when the session is idle", async () => {
    renderPanel({ isProcessing: false });
    await enterEditMode();
    expect(screen.queryByText(/agent is running/i)).toBeNull();
  });
});

/// The pin is gone: `ReviewLayout` decides from a measured width whether the list is a column or
/// an overlay, which is the choice the pin was being asked to make by hand.
describe("WorkspaceFilesPanel file list", () => {
  beforeEach(() => {
    listContents.mockImplementation((_conn: unknown, path: string) =>
      Promise.resolve(path === WORKSPACE ? [{ name: "src", is_dir: true }] : []),
    );
  });

  it("offers no pin", async () => {
    renderPanel();
    await screen.findByRole("button", { name: "Hide file list" });
    expect(screen.queryByRole("button", { name: /pin/i })).toBeNull();
  });

  it("hides and shows the list from the one toggle", async () => {
    renderPanel();
    expect(await screen.findByText("src")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Hide file list" }));

    await waitFor(() => expect(screen.queryByText("src")).toBeNull());

    await userEvent.click(screen.getByRole("button", { name: "Show file list" }));

    expect(await screen.findByText("src")).toBeInTheDocument();
  });

  /// The create and visibility actions arrive and leave with the list they act on — pointing them
  /// at a folder nobody can see is worse than not offering them.
  it("mounts the create actions only while the list is open", async () => {
    renderPanel();
    expect(
      await screen.findByRole("button", { name: "New file in the workspace root" }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Hide file list" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: /^New file in/ })).toBeNull());
    expect(screen.queryByRole("button", { name: /hidden files/ })).toBeNull();
  });
});

/// Reported from real use: the create actions act on a folder, but nothing on screen said which
/// one. The tree now highlights it and every affordance names it.
describe("WorkspaceFilesPanel create destination", () => {
  beforeEach(() => {
    listContents.mockImplementation((_conn: unknown, path: string) =>
      Promise.resolve(
        path === WORKSPACE ? [{ name: "src", is_dir: true }] : [{ name: "main.ts", is_dir: false }],
      ),
    );
  });

  it("names the workspace root as the destination before any folder is picked", async () => {
    renderPanel({ initialPath: undefined });

    expect(
      await screen.findByRole("button", { name: "New file in the workspace root" }),
    ).toBeInTheDocument();
  });

  it("retargets the create buttons at a folder once it is clicked", async () => {
    renderPanel({ initialPath: undefined });
    await userEvent.click(await screen.findByRole("button", { name: /src/ }));

    expect(await screen.findByRole("button", { name: "New file in src" })).toBeInTheDocument();
  });

  it("spells out the destination in the create dialog", async () => {
    renderPanel({ initialPath: undefined });
    await userEvent.click(await screen.findByRole("button", { name: /src/ }));
    await userEvent.click(await screen.findByRole("button", { name: "New file in src" }));

    expect(await screen.findByText(/Created in src/)).toBeInTheDocument();
  });

  it("creates in the highlighted folder, not the root", async () => {
    createFileAt.mockResolvedValue(null);
    renderPanel({ initialPath: undefined });
    await userEvent.click(await screen.findByRole("button", { name: /src/ }));
    await userEvent.click(await screen.findByRole("button", { name: "New file in src" }));

    await userEvent.type(await screen.findByRole("textbox"), "helper.ts");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(createFileAt).toHaveBeenCalledWith(CONNECTION, `${WORKSPACE}/src/helper.ts`),
    );
  });
});

describe("WorkspaceFilesPanel markdown preview", () => {
  async function enterMarkdownEdit() {
    renderPanel({ initialPath: "README.md" });
    await waitFor(() => expect(screen.getByTestId("read-view")).toHaveTextContent("original"));
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => expect(screen.getByTestId("editor")).toBeInTheDocument());
  }

  it("offers the three layouts for markdown", async () => {
    await enterMarkdownEdit();
    expect(screen.getByRole("button", { name: "Source only" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Source and preview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview only" })).toBeInTheDocument();
  });

  it("offers no layout toggle for a file that is not markdown", async () => {
    renderPanel({ initialPath: "src/main.ts" });
    await enterEditMode();

    expect(screen.queryByRole("button", { name: "Preview only" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Source and preview" })).toBeNull();
  });

  it("opens in source view when nothing has been chosen before", async () => {
    await enterMarkdownEdit();
    expect(screen.getByTestId("editor")).toBeInTheDocument();
    expect(screen.queryByTestId("read-view")).toBeNull();
  });

  /// The point of the preview is to see the edit. Rendering what is on disk while the user is
  /// typing something else would be worse than having no preview at all.
  it("renders the draft, not the file on disk", async () => {
    await enterMarkdownEdit();
    await typeDraft("# my heading");

    await userEvent.click(screen.getByRole("button", { name: "Preview only" }));

    await waitFor(() => expect(screen.getByTestId("read-view")).toHaveTextContent("my heading"));
    expect(screen.queryByTestId("editor")).toBeNull();
  });

  it("shows editor and preview together in split", async () => {
    await enterMarkdownEdit();
    await typeDraft("# my heading");

    await userEvent.click(screen.getByRole("button", { name: "Source and preview" }));

    await waitFor(() => expect(screen.getByTestId("read-view")).toHaveTextContent("my heading"));
    expect(screen.getByTestId("editor")).toBeInTheDocument();
  });

  it("goes back to the source with the draft intact", async () => {
    await enterMarkdownEdit();
    await typeDraft("# my heading");
    await userEvent.click(screen.getByRole("button", { name: "Preview only" }));
    await waitFor(() => expect(screen.queryByTestId("editor")).toBeNull());

    await userEvent.click(screen.getByRole("button", { name: "Source only" }));

    await waitFor(() => expect(screen.getByTestId("editor")).toHaveValue("# my heading"));
  });

  it("can still save from the preview, and saves the draft", async () => {
    await enterMarkdownEdit();
    await typeDraft("# my heading");
    await userEvent.click(screen.getByRole("button", { name: "Preview only" }));

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(writeFile).toHaveBeenCalledWith(CONNECTION, `${WORKSPACE}/README.md`, "# my heading"),
    );
  });

  /// happy-dom lays nothing out, so the edit area is driven directly here. The arithmetic behind
  /// the threshold is covered by `resolveMarkdownLayout`; this checks the panel is wired to it.
  it("collapses split to a single pane when the panel is too narrow", async () => {
    getSettings.mockResolvedValue({ markdown_edit_layout: "split", updated_at: "now" });
    await enterMarkdownEdit();
    await waitFor(() => expect(screen.getByTestId("read-view")).toBeInTheDocument());

    resizeEditArea(600);

    await waitFor(() => expect(screen.queryByTestId("read-view")).toBeNull());
    expect(screen.getByTestId("editor")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Source and preview" })).toBeDisabled();
  });

  it("brings split back when the panel is widened again", async () => {
    getSettings.mockResolvedValue({ markdown_edit_layout: "split", updated_at: "now" });
    await enterMarkdownEdit();
    resizeEditArea(600);
    await waitFor(() => expect(screen.queryByTestId("read-view")).toBeNull());

    resizeEditArea(1400);

    await waitFor(() => expect(screen.getByTestId("read-view")).toBeInTheDocument());
    expect(screen.getByTestId("editor")).toBeInTheDocument();
  });

  /// The sync is the point of the split view, so a user who has never touched the toggle gets it
  /// on — the stored value is `null` until they do.
  it("has synced scrolling on by default", async () => {
    getSettings.mockResolvedValue({ markdown_edit_layout: "split", updated_at: "now" });
    await enterMarkdownEdit();

    expect(
      await screen.findByRole("button", { name: "Turn off synced scrolling" }),
    ).toBeInTheDocument();
  });

  it("honours a stored off", async () => {
    getSettings.mockResolvedValue({
      markdown_edit_layout: "split",
      markdown_scroll_sync: false,
      updated_at: "now",
    });
    await enterMarkdownEdit();

    expect(
      await screen.findByRole("button", { name: "Turn on synced scrolling" }),
    ).toBeInTheDocument();
  });

  it("persists the sync toggle so it survives a restart", async () => {
    getSettings.mockResolvedValue({ markdown_edit_layout: "split", updated_at: "now" });
    await enterMarkdownEdit();

    await userEvent.click(await screen.findByRole("button", { name: "Turn off synced scrolling" }));

    await waitFor(() =>
      expect(saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ markdown_scroll_sync: false }),
      ),
    );
    expect(
      await screen.findByRole("button", { name: "Turn on synced scrolling" }),
    ).toBeInTheDocument();
  });

  /// With one pane there is nothing to keep in step, and a toggle that does nothing is worse than
  /// no toggle at all.
  it("offers no sync toggle outside the split view", async () => {
    await enterMarkdownEdit();

    expect(screen.queryByRole("button", { name: /synced scrolling/ })).toBeNull();
  });

  it("hides the sync toggle when the split collapses for width", async () => {
    getSettings.mockResolvedValue({ markdown_edit_layout: "split", updated_at: "now" });
    await enterMarkdownEdit();
    await screen.findByRole("button", { name: "Turn off synced scrolling" });

    resizeEditArea(600);

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /synced scrolling/ })).toBeNull(),
    );
  });

  it("persists the chosen layout so it survives a restart", async () => {
    await enterMarkdownEdit();

    await userEvent.click(screen.getByRole("button", { name: "Source and preview" }));

    await waitFor(() =>
      expect(saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ markdown_edit_layout: "split" }),
      ),
    );
  });

  it("opens a later edit in the stored layout rather than resetting to source", async () => {
    getSettings.mockResolvedValue({ markdown_edit_layout: "split", updated_at: "now" });
    await enterMarkdownEdit();

    await waitFor(() => expect(screen.getByTestId("read-view")).toBeInTheDocument());
    expect(screen.getByTestId("editor")).toBeInTheDocument();
  });

  /// The column is shared free text, so a value from a newer build — or a hand-edited row — must
  /// not leave the pane blank.
  it("falls back to source on an unrecognised stored layout", async () => {
    getSettings.mockResolvedValue({ markdown_edit_layout: "three-up", updated_at: "now" });
    await enterMarkdownEdit();

    expect(screen.getByTestId("editor")).toBeInTheDocument();
    expect(screen.queryByTestId("read-view")).toBeNull();
  });
});

describe("WorkspaceFilesPanel conflict handling", () => {
  async function reachConflict() {
    renderPanel();
    await enterEditMode();
    await typeDraft("mine");
    readFile.mockResolvedValue("the agent's version");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.getByText(/changed while you were editing/i)).toBeInTheDocument(),
    );
  }

  it("asks before replacing a file something else wrote", async () => {
    await reachConflict();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("overwrites with the draft when that is what the user picks", async () => {
    await reachConflict();
    await userEvent.click(screen.getByRole("button", { name: "Overwrite" }));

    await waitFor(() =>
      expect(writeFile).toHaveBeenCalledWith(CONNECTION, `${WORKSPACE}/src/main.ts`, "mine"),
    );
  });

  it("reloads the file from disk without writing when that is what the user picks", async () => {
    await reachConflict();
    const before = screen.getByTestId("editor").getAttribute("data-epoch");

    await userEvent.click(screen.getByRole("button", { name: /Reload, discarding mine/ }));

    await waitFor(() => expect(screen.getByTestId("editor")).toHaveValue("the agent's version"));
    // A new epoch is what tells the editor it may replace its buffer.
    expect(screen.getByTestId("editor").getAttribute("data-epoch")).not.toBe(before);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("leaves everything untouched on cancel", async () => {
    await reachConflict();
    // Unscoped: the header's exit reads "Discard" on a dirty buffer, so this Cancel is the
    // dialog's and nothing else's.
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByText(/changed while you were editing/i)).toBeNull());
    expect(screen.getByTestId("editor")).toHaveValue("mine");
    expect(writeFile).not.toHaveBeenCalled();
  });
});

describe("WorkspaceFilesPanel unsaved-work guards", () => {
  it("reports its dirty state so the tab can refuse to close", async () => {
    const onDirtyChange = vi.fn();
    renderPanel({ onDirtyChange });
    await enterEditMode();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    await typeDraft("edited");
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
  });

  it("reports itself clean again once the draft is written", async () => {
    const onDirtyChange = vi.fn();
    renderPanel({ onDirtyChange });
    await enterEditMode();
    await typeDraft("edited");
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });

  it("asks before leaving edit mode with unsaved changes", async () => {
    renderPanel();
    await enterEditMode();
    await typeDraft("edited");

    await userEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect(screen.getByText(/Discard unsaved changes/i)).toBeInTheDocument();
    expect(screen.getByTestId("editor")).toBeInTheDocument();
  });

  it("leaves edit mode without asking when nothing was changed", async () => {
    renderPanel();
    await enterEditMode();

    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByTestId("editor")).toBeNull());
    expect(screen.queryByText(/Discard unsaved changes/i)).toBeNull();
  });
});

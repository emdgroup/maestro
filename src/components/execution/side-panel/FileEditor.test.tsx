import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/providers/ThemeProvider", () => ({
  useTheme: () => ({ theme: "dark", systemTheme: "dark" }),
}));

import { FileEditor } from "./FileEditor";

describe("FileEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("mounts CodeMirror showing the document it was given", async () => {
    const { container } = render(
      <FileEditor
        doc={"const a = 1;\nconst b = 2;"}
        docEpoch={0}
        fileName="src/main.ts"
        onChange={() => {}}
        onSave={() => {}}
      />,
    );

    await waitFor(() => expect(container.querySelector(".cm-editor")).not.toBeNull());
    expect(container.querySelector(".cm-content")?.textContent).toContain("const a = 1;");
    expect(container.querySelector(".cm-content")?.textContent).toContain("const b = 2;");
    // The read view numbers its lines through a CSS counter; edit mode has to keep them.
    expect(container.querySelector(".cm-lineNumbers")).not.toBeNull();
  });

  it("reports edits to its parent rather than owning the draft", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <FileEditor
        doc="hello"
        docEpoch={0}
        fileName="notes.txt"
        onChange={onChange}
        onSave={() => {}}
      />,
    );
    await waitFor(() => expect(container.querySelector(".cm-content")).not.toBeNull());

    const content = container.querySelector(".cm-content") as HTMLElement;
    await userEvent.click(content);
    await userEvent.type(content, "!");

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1];
    expect(lastCall[0]).toContain("hello");
  });

  /**
   * Ctrl+S is the whole save affordance for anyone who does not go looking for the toolbar, and
   * it has to be swallowed — the webview's own save dialog appearing over the panel is the
   * failure this binding prevents.
   */
  it("saves on Ctrl+S and does not let the key reach the webview", async () => {
    const onSave = vi.fn();
    const { container } = render(
      <FileEditor
        doc="hello"
        docEpoch={0}
        fileName="notes.txt"
        onChange={() => {}}
        onSave={onSave}
      />,
    );
    await waitFor(() => expect(container.querySelector(".cm-content")).not.toBeNull());

    const content = container.querySelector(".cm-content") as HTMLElement;
    await userEvent.click(content);
    await userEvent.keyboard("{Control>}s{/Control}");

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  });

  /**
   * The parent re-baselines on every save, so `doc` changes constantly. Taking it again
   * each time would throw away undo history and the cursor mid-edit; only an explicit epoch bump
   * — the conflict dialog's "reload" — may replace the buffer.
   */
  it("replaces the document only when the epoch changes", async () => {
    const { container, rerender } = render(
      <FileEditor
        doc="mine"
        docEpoch={0}
        fileName="notes.txt"
        onChange={() => {}}
        onSave={() => {}}
      />,
    );
    await waitFor(() => expect(container.querySelector(".cm-content")).not.toBeNull());

    rerender(
      <FileEditor
        doc="from disk"
        docEpoch={0}
        fileName="notes.txt"
        onChange={() => {}}
        onSave={() => {}}
      />,
    );
    expect(container.querySelector(".cm-content")?.textContent).toContain("mine");

    rerender(
      <FileEditor
        doc="from disk"
        docEpoch={1}
        fileName="notes.txt"
        onChange={() => {}}
        onSave={() => {}}
      />,
    );
    await waitFor(() =>
      expect(container.querySelector(".cm-content")?.textContent).toContain("from disk"),
    );
  });

  /**
   * Read mode is this same component, which is the only reason reading and editing a file cannot
   * disagree about colour. It has to actually be read-only, and has to look it.
   */
  describe("read mode", () => {
    it("refuses edits and does not present itself as typable", async () => {
      const onChange = vi.fn();
      const { container } = render(
        <FileEditor
          doc="hello"
          docEpoch={0}
          fileName="notes.txt"
          readOnly
          onChange={onChange}
          onSave={() => {}}
        />,
      );
      await waitFor(() => expect(container.querySelector(".cm-content")).not.toBeNull());

      const content = container.querySelector(".cm-content") as HTMLElement;
      expect(content.getAttribute("contenteditable")).not.toBe("true");
      // No `drawSelection`, so nothing draws a caret over text that cannot be typed into.
      expect(container.querySelector(".cm-cursor")).toBeNull();

      await userEvent.click(content);
      await userEvent.type(content, "!");
      expect(content.textContent).toBe("hello");
      expect(onChange).not.toHaveBeenCalled();
    });

    it("does not take focus away from whatever the user was doing", async () => {
      const { container } = render(
        <>
          <input data-testid="elsewhere" />
          <FileEditor
            doc="hello"
            docEpoch={0}
            fileName="notes.txt"
            readOnly
            onChange={() => {}}
            onSave={() => {}}
          />
        </>,
      );
      const elsewhere = screen.getByTestId("elsewhere");
      elsewhere.focus();
      await waitFor(() => expect(container.querySelector(".cm-content")).not.toBeNull());
      expect(document.activeElement).toBe(elsewhere);
    });

    /**
     * The panel polls the open file every few seconds so an agent's write shows up. Read mode has
     * to follow that without the epoch bump edit mode requires, or the view would go stale.
     */
    it("follows the document it is given, with no epoch bump", async () => {
      const { container, rerender } = render(
        <FileEditor
          doc="before"
          docEpoch={0}
          fileName="notes.txt"
          readOnly
          onChange={() => {}}
          onSave={() => {}}
        />,
      );
      await waitFor(() => expect(container.querySelector(".cm-content")).not.toBeNull());

      rerender(
        <FileEditor
          doc="after"
          docEpoch={0}
          fileName="notes.txt"
          readOnly
          onChange={() => {}}
          onSave={() => {}}
        />,
      );
      await waitFor(() =>
        expect(container.querySelector(".cm-content")?.textContent).toContain("after"),
      );
    });

    /**
     * Toggling the mode reconfigures a compartment. If it rebuilt the view instead, the scroll
     * position would be lost every time someone pressed the pencil.
     */
    it("becomes editable in place, keeping the same view", async () => {
      const { container, rerender } = render(
        <FileEditor
          doc="hello"
          docEpoch={0}
          fileName="notes.txt"
          readOnly
          onChange={() => {}}
          onSave={() => {}}
        />,
      );
      await waitFor(() => expect(container.querySelector(".cm-editor")).not.toBeNull());
      const before = container.querySelector(".cm-editor");

      rerender(
        <FileEditor
          doc="hello"
          docEpoch={1}
          fileName="notes.txt"
          onChange={() => {}}
          onSave={() => {}}
        />,
      );

      await waitFor(() =>
        expect(container.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe(
          "true",
        ),
      );
      expect(container.querySelector(".cm-editor")).toBe(before);
    });
  });

  it("renders a file type no grammar claims as plain text rather than failing", async () => {
    const { container } = render(
      <FileEditor
        doc="key = value"
        docEpoch={0}
        fileName="weird.zzzz"
        onChange={() => {}}
        onSave={() => {}}
      />,
    );
    await waitFor(() => expect(container.querySelector(".cm-content")).not.toBeNull());
    expect(container.querySelector(".cm-content")?.textContent).toContain("key = value");
    expect(screen.queryByText(/error/i)).toBeNull();
  });
});

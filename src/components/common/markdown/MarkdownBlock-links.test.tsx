import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const openUrl = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (url: string) => openUrl(url) }));

import { MarkdownBlock, OpenFileContext } from "./MarkdownBlock";

function renderLink(markdown: string) {
  const openFile = vi.fn();
  render(
    <OpenFileContext.Provider value={openFile}>
      <MarkdownBlock text={markdown} />
    </OpenFileContext.Provider>,
  );
  return openFile;
}

describe("MarkdownBlock links", () => {
  it("opens a project-relative path with a line anchor in the side panel", async () => {
    const openFile = renderLink("[ThemeProvider.tsx#L263](src/providers/ThemeProvider.tsx#L263)");
    await userEvent.click(screen.getByText("ThemeProvider.tsx#L263"));
    expect(openFile).toHaveBeenCalledWith("src/providers/ThemeProvider.tsx#L263");
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("still sends a web link to the browser", async () => {
    const openFile = renderLink("[docs](https://example.com/a#L1)");
    await userEvent.click(screen.getByText("docs"));
    expect(openUrl).toHaveBeenCalledWith("https://example.com/a#L1");
    expect(openFile).not.toHaveBeenCalled();
  });
});

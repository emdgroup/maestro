import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { COMMAND_TAG, splitCommandText, rehypeSlashCommands } from "./markdown-commands";
import { MarkdownBlock, CommandsContext } from "./MarkdownBlock";
import type { AvailableCommand } from "./types";

type Node = { type: string; tagName?: string; value?: string; children?: Node[] };

const text = (value: string): Node => ({ type: "text", value });
const el = (tagName: string, ...children: Node[]): Node => ({ type: "element", tagName, children });

/** The command names produced for a run of text, in order. */
function names(value: string): string[] {
  const parts = splitCommandText(value);
  if (!parts) return [];
  return parts.filter((p) => p.tagName === COMMAND_TAG).map((p) => p.children![0].value!);
}

describe("splitCommandText", () => {
  it("matches a bare command", () => {
    expect(names("/review")).toEqual(["/review"]);
  });

  it("matches after whitespace, mid-sentence", () => {
    expect(names("please run /review on this")).toEqual(["/review"]);
  });

  it("matches namespaced names in both separator styles", () => {
    expect(names("/ponytail:ponytail-audit and /caveman-commit")).toEqual([
      "/ponytail:ponytail-audit",
      "/caveman-commit",
    ]);
  });

  it("rejects paths — the regex must not backtrack into a shorter match", () => {
    expect(names("/usr/local/bin")).toEqual([]);
    expect(names("see /etc/hosts for it")).toEqual([]);
  });

  it("rejects a slash that is not at a word boundary", () => {
    expect(names("./relative")).toEqual([]);
    expect(names("a/b")).toEqual([]);
  });

  it("keeps trailing punctuation out of the name", () => {
    expect(names("run /compact.")).toEqual(["/compact"]);
  });

  it("preserves the surrounding text verbatim", () => {
    const parts = splitCommandText("run /review now")!;
    expect(parts.map((p) => p.value ?? p.children![0].value).join("")).toBe("run /review now");
  });

  it("returns null when there is nothing to mark", () => {
    expect(splitCommandText("no commands here")).toBeNull();
  });
});

describe("rehypeSlashCommands", () => {
  it("leaves code and pre subtrees alone", () => {
    const tree: Node = {
      type: "root",
      children: [el("pre", el("code", text("curl /api-endpoint"))), el("p", text("/review this"))],
    };
    rehypeSlashCommands()(tree);
    expect(tree.children![0].children![0].children).toEqual([text("curl /api-endpoint")]);
    expect(tree.children![1].children![0].tagName).toBe(COMMAND_TAG);
  });

  it("leaves link text alone", () => {
    const tree: Node = { type: "root", children: [el("a", text("/review"))] };
    rehypeSlashCommands()(tree);
    expect(tree.children![0].children).toEqual([text("/review")]);
  });
});

// Guards the seam the unit tests above cannot see: that react-markdown hands the
// hast property through to the component under a name it actually reads.
describe("MarkdownBlock slashCommands", () => {
  const loaded: AvailableCommand[] = [{ name: "review", description: "Review a pull request" }];

  const renderWith = (available: AvailableCommand[], text = "run /review now") =>
    render(
      <CommandsContext.Provider value={available}>
        <MarkdownBlock text={text} slashCommands />
      </CommandsContext.Provider>,
    );

  it("renders a tooltip trigger for a known command", () => {
    renderWith(loaded);
    const trigger = screen.getByText("/review").closest("[data-slot=tooltip-trigger]");
    expect(trigger).not.toBeNull();
  });

  it("highlights without a tooltip when the command list never arrived", () => {
    renderWith([]);
    const chip = screen.getByText("/review");
    expect(chip.className).toContain("text-accent");
    expect(chip.closest("[data-slot=tooltip-trigger]")).toBeNull();
  });

  it("leaves an unknown command plain once the list is loaded", () => {
    const { container } = renderWith(loaded, "run /deploy now");
    expect(container.textContent).toBe("run /deploy now");
    expect(container.querySelector("[data-slot=tooltip-trigger]")).toBeNull();
    expect(container.querySelector(".text-accent")).toBeNull();
  });

  it("does nothing without the opt-in", () => {
    const { container } = render(
      <CommandsContext.Provider value={loaded}>
        <MarkdownBlock text="run /review now" />
      </CommandsContext.Provider>,
    );
    expect(container.querySelector("[data-slot=tooltip-trigger]")).toBeNull();
  });
});

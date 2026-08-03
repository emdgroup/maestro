import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  classifyContextTarget,
  registerTerminal,
  unregisterTerminal,
  TERMINAL_CONTAINER_ATTRIBUTE,
} from "./editCommands";
import type { Terminal } from "@xterm/xterm";

function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

function select(node: Node): void {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

afterEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});

describe("classifyContextTarget", () => {
  it("returns none for a non-element target", () => {
    expect(classifyContextTarget(null).kind).toBe("none");
  });

  it("returns none for plain content with no selection", () => {
    const host = mount("<p>hello</p>");
    expect(classifyContextTarget(host.querySelector("p")).kind).toBe("none");
  });

  it("treats a text input as an edit target", () => {
    const host = mount("<input type='text' value='hello' />");
    const input = host.querySelector("input")!;
    input.setSelectionRange(1, 4);

    const target = classifyContextTarget(input);
    expect(target.kind).toBe("edit");
    if (target.kind !== "edit") return;
    expect(target.writable).toBe(true);
    expect(target.hasSelection).toBe(true);
    expect(target.selection).toEqual({ type: "input", start: 1, end: 4 });
  });

  it("reports a collapsed caret as having no selection", () => {
    const host = mount("<textarea>hello</textarea>");
    const textarea = host.querySelector("textarea")!;
    textarea.setSelectionRange(2, 2);

    const target = classifyContextTarget(textarea);
    expect(target.kind).toBe("edit");
    if (target.kind !== "edit") return;
    expect(target.hasSelection).toBe(false);
  });

  it("marks readonly and disabled fields as not writable", () => {
    const host = mount("<input type='text' readonly /><input type='text' disabled />");
    const [readonly, disabled] = Array.from(host.querySelectorAll("input"));

    for (const field of [readonly, disabled]) {
      const target = classifyContextTarget(field);
      expect(target.kind).toBe("edit");
      if (target.kind !== "edit") continue;
      expect(target.writable).toBe(false);
    }
  });

  it("ignores non-text input types", () => {
    const host = mount("<input type='checkbox' /><input type='range' />");
    for (const field of Array.from(host.querySelectorAll("input"))) {
      expect(classifyContextTarget(field).kind).toBe("none");
    }
  });

  it("resolves the edit target from a descendant of a contenteditable", () => {
    const host = mount("<div contenteditable='true'><span>text</span></div>");
    const span = host.querySelector("span")!;

    const target = classifyContextTarget(span);
    expect(target.kind).toBe("edit");
    if (target.kind !== "edit") return;
    expect(target.element).toBe(host.querySelector("[contenteditable]"));
  });

  it("offers copy for a selection in read-only content", () => {
    const host = mount("<p>agent output</p>");
    const paragraph = host.querySelector("p")!;
    select(paragraph);

    const target = classifyContextTarget(paragraph);
    expect(target.kind).toBe("selection");
    if (target.kind !== "selection") return;
    expect(target.text).toContain("agent output");
  });
});

describe("terminal registry", () => {
  let container: HTMLElement;
  const terminal = { id: "fake" } as unknown as Terminal;

  beforeEach(() => {
    const host = mount(`<div ${TERMINAL_CONTAINER_ATTRIBUTE}><span>line</span></div>`);
    container = host.querySelector(`[${TERMINAL_CONTAINER_ATTRIBUTE}]`) as HTMLElement;
  });

  it("resolves a registered terminal from a descendant", () => {
    registerTerminal(container, terminal);

    const target = classifyContextTarget(container.querySelector("span"));
    expect(target.kind).toBe("terminal");
    if (target.kind !== "terminal") return;
    expect(target.terminal).toBe(terminal);

    unregisterTerminal(container);
  });

  it("returns none inside a terminal container with no registered instance", () => {
    // Guards against showing DOM clipboard commands over an xterm surface, where
    // they would act on the wrong selection.
    expect(classifyContextTarget(container.querySelector("span")).kind).toBe("none");
  });
});

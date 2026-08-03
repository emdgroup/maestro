import type { Terminal } from "@xterm/xterm";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

/**
 * xterm owns its own selection model, so a DOM `execCommand("copy")` inside a
 * terminal copies the wrong thing (usually nothing). Terminal components register
 * their container here so the context menu can reach the instance and use
 * `getSelection()` / `paste()` instead.
 */
const terminals = new WeakMap<HTMLElement, Terminal>();

export const TERMINAL_CONTAINER_ATTRIBUTE = "data-maestro-terminal";

export function registerTerminal(container: HTMLElement, terminal: Terminal): void {
  terminals.set(container, terminal);
}

export function unregisterTerminal(container: HTMLElement): void {
  terminals.delete(container);
}

/**
 * Text-like input types only. A right-click on a checkbox, radio, colour swatch
 * or range slider must not offer cut/paste.
 */
const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "email", "password", "number"]);

type SavedSelection =
  | { type: "input"; start: number; end: number }
  | { type: "range"; range: Range }
  | null;

export interface EditTarget {
  kind: "edit";
  element: HTMLElement;
  selection: SavedSelection;
  /** False for readonly/disabled fields, where cut and paste must not be offered. */
  writable: boolean;
  hasSelection: boolean;
}

export type ContextTarget =
  | EditTarget
  | { kind: "terminal"; container: HTMLElement; terminal: Terminal }
  | { kind: "selection"; text: string }
  | { kind: "none" };

function isTextEntry(element: HTMLElement): boolean {
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(element.type);
  return element.isContentEditable;
}

function captureSelection(element: HTMLElement): {
  selection: SavedSelection;
  hasSelection: boolean;
} {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const start = element.selectionStart ?? 0;
    const end = element.selectionEnd ?? 0;
    return { selection: { type: "input", start, end }, hasSelection: end > start };
  }

  const selection = window.getSelection();
  if (selection && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0).cloneRange();
    return { selection: { type: "range", range }, hasSelection: !range.collapsed };
  }
  return { selection: null, hasSelection: false };
}

/**
 * Decides what menu — if any — a right-click should produce. Called after the
 * native menu has already been suppressed, so returning "none" means no menu at all.
 */
export function classifyContextTarget(target: EventTarget | null): ContextTarget {
  if (!(target instanceof HTMLElement)) return { kind: "none" };

  const terminalContainer = target.closest<HTMLElement>(`[${TERMINAL_CONTAINER_ATTRIBUTE}]`);
  if (terminalContainer) {
    const terminal = terminals.get(terminalContainer);
    return terminal
      ? { kind: "terminal", container: terminalContainer, terminal }
      : { kind: "none" };
  }

  const editable = target.closest<HTMLElement>("input, textarea, [contenteditable='true']");
  if (editable && isTextEntry(editable)) {
    const writable = !(
      (editable as HTMLInputElement | HTMLTextAreaElement).readOnly ||
      (editable as HTMLInputElement | HTMLTextAreaElement).disabled
    );
    return { kind: "edit", element: editable, writable, ...captureSelection(editable) };
  }

  const selection = window.getSelection();
  const text = selection && !selection.isCollapsed ? selection.toString() : "";
  if (text) return { kind: "selection", text };

  return { kind: "none" };
}

/**
 * Opening the menu can move focus and collapse the caret, so every command
 * re-establishes the state captured at right-click time before running.
 */
function restoreSelection(target: EditTarget): void {
  target.element.focus({ preventScroll: true });

  const saved = target.selection;
  if (saved?.type === "input") {
    const field = target.element as HTMLInputElement | HTMLTextAreaElement;
    field.setSelectionRange(saved.start, saved.end);
  } else if (saved?.type === "range") {
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(saved.range);
  }
}

export type EditCommand = "cut" | "copy" | "selectAll" | "undo" | "redo";

export function runEditCommand(target: EditTarget, command: EditCommand): void {
  restoreSelection(target);
  document.execCommand(command);
}

export async function pasteIntoTarget(target: EditTarget): Promise<void> {
  let text: string;
  try {
    text = await readText();
  } catch (error) {
    console.error("Failed to read the clipboard:", error);
    return;
  }
  if (!text) return;

  restoreSelection(target);
  // `execCommand("paste")` is blocked in Chromium and WebKit, and assigning
  // `element.value` would not fire React's onChange — React patches the value
  // setter, so state would silently go stale. `insertText` dispatches a real
  // input event and preserves the native undo stack.
  document.execCommand("insertText", false, text);
}

export async function copyText(text: string): Promise<void> {
  try {
    await writeText(text);
  } catch (error) {
    console.error("Failed to write to the clipboard:", error);
  }
}

export async function copyTerminalSelection(terminal: Terminal): Promise<void> {
  const text = terminal.getSelection();
  if (text) await copyText(text);
}

export async function pasteIntoTerminal(terminal: Terminal): Promise<void> {
  try {
    const text = await readText();
    if (text) terminal.paste(text);
  } catch (error) {
    console.error("Failed to read the clipboard:", error);
  }
}

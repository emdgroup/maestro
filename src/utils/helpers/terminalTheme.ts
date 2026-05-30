import type { ITerminalOptions, ITheme } from "@xterm/xterm";
import type { TerminalColorMode } from "@/types/bindings";

function cssVar(varName: string): string {
  const el = document.createElement("div");
  el.style.display = "none";
  el.style.backgroundColor = `var(${varName})`;
  document.body.appendChild(el);
  const color = getComputedStyle(el).backgroundColor;
  document.body.removeChild(el);
  return color;
}

/** Returns just the theme object for in-place updates on an existing terminal instance. */
export function getTerminalThemeOnly(colorMode?: TerminalColorMode): ITheme | undefined {
  if (colorMode === "default") return undefined;
  return {
    background: cssVar("--background"),
    foreground: cssVar("--foreground"),
    cursor: cssVar("--foreground"),
    selectionBackground: cssVar("--accent"),
  };
}

export function getTerminalTheme(colorMode?: TerminalColorMode): ITerminalOptions {
  const base: ITerminalOptions = {
    fontFamily: '"FiraCode Nerd Font Mono", "Fira Code", monospace',
    fontSize: 13,
  };
  const theme = getTerminalThemeOnly(colorMode);
  return theme ? { ...base, theme } : base;
}

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

function getAnsiPalette(isDark: boolean): Partial<ITheme> {
  if (isDark) {
    return {
      black: "#282c34",
      red: "#e06c75",
      green: "#98c379",
      yellow: "#e5c07b",
      blue: "#61afef",
      magenta: "#c678dd",
      cyan: "#56b6c2",
      white: "#abb2bf",
      brightBlack: "#5c6370",
      brightRed: "#e06c75",
      brightGreen: "#98c379",
      brightYellow: "#e5c07b",
      brightBlue: "#61afef",
      brightMagenta: "#c678dd",
      brightCyan: "#56b6c2",
      brightWhite: "#ffffff",
    };
  }
  return {
    black: "#383a42",
    red: "#e45649",
    green: "#50a14f",
    yellow: "#c18401",
    blue: "#4078f2",
    magenta: "#a626a4",
    cyan: "#0184bc",
    white: "#383a42",
    brightBlack: "#a0a1a7",
    brightRed: "#e45649",
    brightGreen: "#50a14f",
    brightYellow: "#c18401",
    brightBlue: "#4078f2",
    brightMagenta: "#a626a4",
    brightCyan: "#0184bc",
    brightWhite: "#fafafa",
  };
}

/** Returns just the theme object for in-place updates on an existing terminal instance. */
export function getTerminalThemeOnly(colorMode?: TerminalColorMode): ITheme | undefined {
  if (colorMode === "default") return undefined;
  const isDark = document.documentElement.classList.contains("dark");
  return {
    background: cssVar("--background"),
    foreground: cssVar("--foreground"),
    cursor: cssVar("--foreground"),
    selectionBackground: cssVar("--accent"),
    ...getAnsiPalette(isDark),
  };
}

export function getTerminalTheme(colorMode?: TerminalColorMode): ITerminalOptions {
  const base: ITerminalOptions = {
    fontFamily:
      '"JetBrainsMono Nerd Font Mono", "JetBrains Mono", "FiraCode Nerd Font Mono", "Fira Code", monospace',
    fontSize: 13,
    letterSpacing: 0,
  };
  const theme = getTerminalThemeOnly(colorMode);
  return theme ? { ...base, theme } : base;
}

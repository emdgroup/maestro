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

// xterm only parses a translucent color written as rgba(); anything else it reads through a
// canvas and rejects unless opaque, silently falling back to its default. Hence the round trip.
function mutedForeground(alpha: number): string {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return `rgba(128, 128, 128, ${alpha})`;
  ctx.fillStyle = cssVar("--muted-foreground");
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// xterm draws its own scrollbar, so the app-wide ::-webkit-scrollbar rules in index.css never
// reach it. These mirror them; the width is `overviewRuler.width` below and the radius is CSS.
// App chrome rather than terminal colors, so they apply in the "default" color mode too.
function getScrollbarTheme(): ITheme {
  return {
    scrollbarSliderBackground: mutedForeground(0.3),
    scrollbarSliderHoverBackground: mutedForeground(0.5),
    scrollbarSliderActiveBackground: mutedForeground(0.5),
    // Setting overviewRuler.width also enables the ruler, which draws a 1px line in this color,
    // white by default. "transparent" is rejected like any other non-rgba translucent color.
    overviewRulerBorder: "rgba(0, 0, 0, 0)",
  };
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
export function getTerminalThemeOnly(colorMode?: TerminalColorMode): ITheme {
  if (colorMode === "default") return getScrollbarTheme();
  const isDark = document.documentElement.classList.contains("dark");
  return {
    background: cssVar("--background"),
    foreground: cssVar("--foreground"),
    cursor: cssVar("--foreground"),
    selectionBackground: cssVar("--accent"),
    ...getAnsiPalette(isDark),
    ...getScrollbarTheme(),
  };
}

export function getTerminalTheme(colorMode?: TerminalColorMode): ITerminalOptions {
  const base: ITerminalOptions = {
    fontFamily:
      '"JetBrainsMono Nerd Font Mono", "JetBrains Mono", "FiraCode Nerd Font Mono", "Fira Code", monospace',
    fontSize: 13,
    letterSpacing: 0,
    // Also sizes the scrollbar: 8px, as in index.css. FitAddon reads the same value.
    overviewRuler: { width: 8 },
  };
  return { ...base, theme: getTerminalThemeOnly(colorMode) };
}

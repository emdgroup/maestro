import type { ITerminalOptions } from "@xterm/xterm";

/**
 * Resolve a CSS custom property to its computed RGB value by temporarily
 * appending an invisible div to the document body and reading getComputedStyle.
 * The browser handles oklch → rgb conversion automatically.
 */
function cssVar(varName: string): string {
  const el = document.createElement("div");
  el.style.display = "none";
  el.style.backgroundColor = `var(${varName})`;
  document.body.appendChild(el);
  const color = getComputedStyle(el).backgroundColor;
  document.body.removeChild(el);
  return color;
}

/**
 * Build xterm.js terminal options that match the app's current CSS variable
 * theme. Call this inside a useEffect (after DOM + theme class are applied)
 * so that computed styles resolve correctly for both light and dark mode.
 */
export function getTerminalTheme(): ITerminalOptions {
  return {
    fontFamily: '"Fira Code", "Cascadia Code", "DejaVu Sans Mono", Menlo, Consolas, monospace',
    fontSize: 13,
    theme: {
      background: cssVar("--background"),
      foreground: cssVar("--foreground"),
      cursor: cssVar("--foreground"),
      selectionBackground: cssVar("--accent"),
    },
  };
}

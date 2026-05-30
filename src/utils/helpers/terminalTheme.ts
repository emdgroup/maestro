import type { ITerminalOptions } from "@xterm/xterm";
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

export function getTerminalTheme(colorMode?: TerminalColorMode): ITerminalOptions {
  const base: ITerminalOptions = {
    fontFamily: '"FiraCode Nerd Font Mono", "Fira Code", monospace',
    fontSize: 13,
  };

  if (colorMode === "default") {
    return base;
  }

  return {
    ...base,
    theme: {
      background: cssVar("--background"),
      foreground: cssVar("--foreground"),
      cursor: cssVar("--foreground"),
      selectionBackground: cssVar("--accent"),
    },
  };
}

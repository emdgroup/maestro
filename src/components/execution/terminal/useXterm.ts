import { useEffect, useRef, type DependencyList, type RefObject } from "react";
import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { getTerminalTheme, getTerminalColorOptions } from "@/lib/terminalTheme";
import { useSettings } from "@/services/settings.service";
import { useTheme } from "@/providers/ThemeProvider";
import {
  registerTerminal,
  unregisterTerminal,
} from "@/components/common/context-menu/editCommands";
import "@xterm/xterm/css/xterm.css";

interface UseXtermOptions {
  /** Merged over `allowProposedApi` and the colour theme. */
  options: ITerminalOptions;
  /** Runs right after the terminal opens, before the first fit. Return a cleanup if needed. */
  onOpen?: (terminal: Terminal) => (() => void) | void;
  /** Runs once the first fit has sized the terminal to its container. */
  onFit?: (terminal: Terminal) => void;
  /** Rebuilds the terminal when any of these change. The callbacks are read at that time. */
  deps: DependencyList;
}

/**
 * An xterm instance in `containerRef`: Unicode 11, the WebGL renderer, fitted to its container,
 * reachable from the app context menu, and recoloured in place when the theme changes.
 */
export function useXterm(
  containerRef: RefObject<HTMLDivElement | null>,
  { options, onOpen, onFit, deps }: UseXtermOptions,
): RefObject<Terminal | null> {
  const xtermRef = useRef<Terminal | null>(null);
  const { data: settings } = useSettings();
  const terminalColorMode = settings?.terminal_color_mode ?? "follow_theme";
  const { theme, systemTheme, effectiveAccentHue } = useTheme();
  const effectiveTheme = theme === "system" ? systemTheme : theme;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      allowProposedApi: true,
      ...options,
      ...getTerminalTheme(terminalColorMode),
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    // Unicode 11 for correct wide character / symbol rendering.
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = "11";

    terminal.open(container);

    // WebGL renderer gives consistent per-pixel character grid, fixing
    // monospace alignment issues in FiraCode's canvas renderer.
    const webglAddon = new WebglAddon();
    webglAddon.onContextLoss(() => webglAddon.dispose());
    terminal.loadAddon(webglAddon);

    xtermRef.current = terminal;

    // Lets AppContextMenu reach this instance: xterm owns its own selection, so
    // the menu must use getSelection()/paste() rather than DOM clipboard commands.
    registerTerminal(container, terminal);

    const cleanup = onOpen?.(terminal);

    // Defer the first fit to the next animation frame so xterm's renderer has
    // computed cell dimensions. Calling fit() synchronously after open() is a
    // no-op (cell sizes are 0 until first paint), leaving the terminal at 80x24
    // until ResizeObserver fires, which flashes a resize on session switch.
    const rafId = requestAnimationFrame(() => {
      fitAddon.fit();
      onFit?.(terminal);
    });

    // Tabs are hidden with display:none, which reports 0x0; fitting on that
    // reflows the buffer to junk dimensions. Skip it, and force a repaint on
    // the way back since the WebGL canvas raster is stale but cols/rows are
    // unchanged, so no resize event would trigger a redraw on its own.
    const resizeObserver = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === 0 || entry.contentRect.height === 0) return;
      fitAddon.fit();
      terminal.refresh(0, terminal.rows - 1);
    });
    resizeObserver.observe(container);

    return () => {
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      unregisterTerminal(container);
      cleanup?.();
      terminal.dispose();
      xtermRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // Update the theme in place when the colour mode or light/dark changes; no rebuild needed.
  useEffect(() => {
    const terminal = xtermRef.current;
    if (!terminal) return;
    terminal.options = getTerminalColorOptions(terminalColorMode);
  }, [terminalColorMode, effectiveTheme, effectiveAccentHue]);

  return xtermRef;
}

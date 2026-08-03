import { useCallback, useEffect, useMemo, useState } from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type { Terminal } from "@xterm/xterm";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "@/components/ui/context-menu";
import {
  classifyContextTarget,
  copyText,
  copyTerminalSelection,
  pasteIntoTarget,
  pasteIntoTerminal,
  runEditCommand,
  type ContextTarget,
  type EditTarget,
} from "./editCommands";

const MOD = navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl+";

interface MenuState {
  target: Exclude<ContextTarget, { kind: "none" }>;
  x: number;
  y: number;
}

/**
 * Replaces the webview's own context menu app-wide.
 *
 * The native menu carries Refresh, Print, Save as and (on WebView2) "Send tab to
 * your devices" — items that are useless or destructive in a desktop app. Tauri
 * exposes no configuration for it, but `preventDefault` on the DOM `contextmenu`
 * event suppresses it identically in WebView2, WKWebView and WebKitGTK.
 *
 * The styled parts come from `components/ui/context-menu.tsx`, but its base-ui
 * `ContextMenu.Root`/`Trigger` deliberately do not: that trigger suppresses the
 * native menu only for targets inside its own subtree, so portalled content —
 * every dialog, drawer and popover — would keep the native menu. Hence a document
 * listener and a plain `Menu.Root` anchored to the cursor. Everything else in that
 * file (`Portal`, `Positioner`, `Popup`, `Item`, `Separator`) is a re-export of the
 * equivalent `Menu` part, so it works unchanged under this root.
 */
export function AppContextMenu() {
  const [state, setState] = useState<MenuState | null>(null);

  useEffect(() => {
    function handleContextMenu(event: MouseEvent) {
      // Debug builds keep an escape hatch to the webview's own menu, which is the
      // only route to element-targeted "Inspect". The flag is inlined at build
      // time, so release bundles contain no bypass at all.
      if (__TAURI_DEBUG_BUILD__ && event.shiftKey) return;

      event.preventDefault();

      const target = classifyContextTarget(event.target);
      setState(target.kind === "none" ? null : { target, x: event.clientX, y: event.clientY });
    }

    document.addEventListener("contextmenu", handleContextMenu);
    return () => document.removeEventListener("contextmenu", handleContextMenu);
  }, []);

  const anchor = useMemo(() => {
    if (!state) return undefined;
    const { x, y } = state;
    return { getBoundingClientRect: () => new DOMRect(x, y, 0, 0) };
  }, [state]);

  const close = useCallback(() => setState(null), []);

  return (
    <MenuPrimitive.Root
      open={state !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <ContextMenuContent anchor={anchor}>
        {state && <MenuItems target={state.target} onDone={close} />}
      </ContextMenuContent>
    </MenuPrimitive.Root>
  );
}

function MenuItems({ target, onDone }: { target: MenuState["target"]; onDone: () => void }) {
  switch (target.kind) {
    case "edit":
      return <EditItems target={target} onDone={onDone} />;
    case "terminal":
      return <TerminalItems terminal={target.terminal} />;
    case "selection":
      return (
        <ContextMenuItem onClick={() => void copyText(target.text)}>
          Copy
          <ContextMenuShortcut>{MOD}C</ContextMenuShortcut>
        </ContextMenuItem>
      );
  }
}

function EditItems({ target, onDone }: { target: EditTarget; onDone: () => void }) {
  const { writable, hasSelection } = target;

  return (
    <>
      {writable && (
        <>
          <ContextMenuItem onClick={() => runEditCommand(target, "undo")}>
            Undo
            <ContextMenuShortcut>{MOD}Z</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onClick={() => runEditCommand(target, "redo")}>
            Redo
            <ContextMenuShortcut>{MOD}Y</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      <ContextMenuItem
        disabled={!writable || !hasSelection}
        onClick={() => runEditCommand(target, "cut")}
      >
        Cut
        <ContextMenuShortcut>{MOD}X</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem disabled={!hasSelection} onClick={() => runEditCommand(target, "copy")}>
        Copy
        <ContextMenuShortcut>{MOD}C</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!writable}
        onClick={() => {
          void pasteIntoTarget(target).finally(onDone);
        }}
      >
        Paste
        <ContextMenuShortcut>{MOD}V</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => runEditCommand(target, "selectAll")}>
        Select All
        <ContextMenuShortcut>{MOD}A</ContextMenuShortcut>
      </ContextMenuItem>
    </>
  );
}

function TerminalItems({ terminal }: { terminal: Terminal }) {
  return (
    <>
      <ContextMenuItem
        disabled={!terminal.hasSelection()}
        onClick={() => void copyTerminalSelection(terminal)}
      >
        Copy
      </ContextMenuItem>
      <ContextMenuItem onClick={() => void pasteIntoTerminal(terminal)}>Paste</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => terminal.selectAll()}>Select All</ContextMenuItem>
    </>
  );
}

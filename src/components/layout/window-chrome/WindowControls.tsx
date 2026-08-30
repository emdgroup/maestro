import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, Copy, X } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { useWindowChrome } from "@/hooks/useWindowChrome";

/**
 * Minimise / maximise / close for the frameless window. Renders nothing when the window is on the
 * OS frame, which already provides them.
 */
export function WindowControls({ className }: { className?: string }) {
  const customChrome = useWindowChrome();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!customChrome) return;
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    const sync = () => {
      void appWindow
        .isMaximized()
        .then((value) => {
          if (!cancelled) setMaximized(value);
        })
        .catch(() => {});
    };

    sync();
    void appWindow
      .onResized(sync)
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [customChrome]);

  if (!customChrome) return null;

  const appWindow = getCurrentWindow();
  const buttonClass =
    "flex h-8 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

  return (
    <div className={cn("flex items-center gap-0.5", className)}>
      <button
        type="button"
        aria-label="Minimize"
        className={buttonClass}
        onClick={() => void appWindow.minimize().catch(() => {})}
      >
        <Minus className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label={maximized ? "Restore" : "Maximize"}
        className={buttonClass}
        onClick={() => void appWindow.toggleMaximize().catch(() => {})}
      >
        {maximized ? <Copy className="size-3" /> : <Square className="size-3" />}
      </button>
      <button
        type="button"
        aria-label="Close"
        className={cn(buttonClass, "hover:bg-destructive hover:text-destructive-foreground")}
        onClick={() => void appWindow.close().catch(() => {})}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

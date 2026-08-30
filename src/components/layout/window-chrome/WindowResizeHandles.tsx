import type React from "react";
import { getCurrentWindow, type Window as TauriWindow } from "@tauri-apps/api/window";
import { useWindowChrome } from "@/hooks/useWindowChrome";

// `ResizeDirection` is declared but not exported by @tauri-apps/api, so take it off the method
// rather than restating the union and letting it drift.
type ResizeDirection = Parameters<TauriWindow["startResizeDragging"]>[0];

/**
 * A frameless window loses the OS resize borders on Windows and Linux, so we put them back as
 * thin transparent strips around the viewport. Renders nothing when the window is on the OS frame.
 *
 * Mounted once at the root so the project picker — which has no AppHeader — is resizable too.
 */
const HANDLES: Array<{ direction: ResizeDirection; className: string }> = [
  { direction: "North", className: "top-0 inset-x-3 h-1 cursor-ns-resize" },
  { direction: "South", className: "bottom-0 inset-x-3 h-1 cursor-ns-resize" },
  { direction: "West", className: "left-0 inset-y-3 w-1 cursor-ew-resize" },
  { direction: "East", className: "right-0 inset-y-3 w-1 cursor-ew-resize" },
  { direction: "NorthWest", className: "top-0 left-0 size-3 cursor-nwse-resize" },
  { direction: "NorthEast", className: "top-0 right-0 size-3 cursor-nesw-resize" },
  { direction: "SouthWest", className: "bottom-0 left-0 size-3 cursor-nesw-resize" },
  { direction: "SouthEast", className: "bottom-0 right-0 size-3 cursor-nwse-resize" },
];

export function WindowResizeHandles() {
  const customChrome = useWindowChrome();
  if (!customChrome) return null;

  const handleMouseDown = (direction: ResizeDirection) => (event: React.MouseEvent) => {
    if (event.button !== 0) return;
    void getCurrentWindow()
      .startResizeDragging(direction)
      .catch(() => {});
  };

  return (
    <div className="pointer-events-none fixed inset-0 z-[9999]">
      {HANDLES.map((handle) => (
        <div
          key={handle.direction}
          className={`pointer-events-auto absolute ${handle.className}`}
          onMouseDown={handleMouseDown(handle.direction)}
        />
      ))}
    </div>
  );
}

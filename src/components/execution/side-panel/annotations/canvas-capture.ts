/**
 * Turning a marquee'd region of a canvas into a PNG the agent can look at.
 *
 * The agent never sees its own surface rendered, so this is the only way to tell it that something
 * it authored correctly still came out wrong — a truncated axis, an overflowing column. It is
 * evidence rather than an anchor: the element ids in the annotation are what the agent acts on,
 * and every failure path here degrades to those.
 *
 * The rasterising happens *inside* the frame, because the surface is a sandboxed document this
 * side cannot read. `modern-screenshot` is pure DOM-to-canvas, so it runs in there as well as out
 * here; the frame is handed its source only when annotation mode is entered.
 */

import { api } from "@/lib/tauri-utils";
import type { CanvasFrameHandle } from "@/components/execution/activity/canvas/CanvasHtml";

export interface CanvasCapture {
  /** Temp PNG on disk, handed to `prepare_external_attachments` when the note is sent. */
  path: string;
  /** The same image inline, so the composer can show a thumbnail without reading it back. */
  dataUrl: string;
}

/**
 * Rasterise `region` of the surface and write it to a temp PNG.
 *
 * `region` is in the frame's own coordinates — the frame does not scroll, so subtracting the
 * iframe's origin from a viewport rect is the whole conversion.
 *
 * Returns null rather than throwing: a capture that fails (a cross-origin image tainting the
 * canvas is the likely cause) must not cost the user the note they were writing.
 */
export async function captureRegion(
  frame: CanvasFrameHandle | null,
  region: { left: number; top: number; width: number; height: number },
): Promise<CanvasCapture | null> {
  if (!frame || region.width < 1 || region.height < 1) return null;

  try {
    const dataUrl = await frame.capture(region);
    if (!dataUrl) return null;
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    if (!base64) return null;

    // Reuses the clipboard-paste path: it already writes to a temp file, and `send` then hands
    // that path to `prepare_external_attachments`, which downscales it and — for an SSH, WSL or
    // container session — copies it to where the agent can reach it.
    const path = await api.saveClipboardImage(base64, "image/png");
    return { path, dataUrl };
  } catch {
    return null;
  }
}

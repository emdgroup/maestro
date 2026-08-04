/**
 * Turning a marquee'd region of a canvas into a PNG the agent can look at.
 *
 * The agent never sees its own surface rendered, so this is the only way to tell it that something
 * it authored correctly still came out wrong — a truncated axis, an overflowing column. It is
 * evidence rather than an anchor: the component ids in the annotation are what the agent acts on,
 * and every failure path here degrades to those.
 */

import { domToCanvas } from "modern-screenshot";
import { api } from "@/lib/tauri-utils";

/** Enough to read small type when the agent looks at it, without a megabyte of base64. */
const PIXEL_RATIO = 2;

export interface CanvasCapture {
  /** Temp PNG on disk, handed to `prepare_external_attachments` when the note is sent. */
  path: string;
  /** The same image inline, so the composer can show a thumbnail without reading it back. */
  dataUrl: string;
}

/**
 * Rasterise `content` and cut `region` out of it, returning a path to a temp PNG.
 *
 * `region` is in viewport coordinates, as the pointer reports it. `content` must be the element
 * holding the canvas *only* — the selection overlay has to live outside it, or the marquee and the
 * bubble end up in the picture.
 *
 * Returns null rather than throwing: a capture that fails (a remote `CanvasImage` tainting the
 * canvas is the likely cause) must not cost the user the note they were writing.
 */
export async function captureRegion(
  content: HTMLElement,
  region: { left: number; top: number; width: number; height: number },
): Promise<CanvasCapture | null> {
  if (region.width < 1 || region.height < 1) return null;

  try {
    const full = await domToCanvas(content, { scale: PIXEL_RATIO, backgroundColor: null });
    const box = content.getBoundingClientRect();

    const cropped = document.createElement("canvas");
    cropped.width = Math.round(region.width * PIXEL_RATIO);
    cropped.height = Math.round(region.height * PIXEL_RATIO);
    const ctx = cropped.getContext("2d");
    if (!ctx) return null;

    ctx.drawImage(
      full,
      Math.round((region.left - box.left) * PIXEL_RATIO),
      Math.round((region.top - box.top) * PIXEL_RATIO),
      cropped.width,
      cropped.height,
      0,
      0,
      cropped.width,
      cropped.height,
    );

    const dataUrl = cropped.toDataURL("image/png");
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

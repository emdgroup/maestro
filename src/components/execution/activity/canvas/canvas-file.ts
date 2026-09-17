/**
 * A saved canvas is one `.html` file that opens in any browser.
 *
 * It holds the agent's document verbatim, plus the few things Maestro needs to rebuild the surface
 * — title, theme, declared sources, and the `canvas_data` bag. Those sit between two marker
 * comments so loading can lift them back out by string and hand the rest back exactly as it was
 * written. Maestro's injected head (Tailwind, the bridge, the frame CSP) is never saved: it is
 * what the app wraps around the document, not part of it.
 */

import type { CanvasSurface, CanvasTheme } from "../types";

const BEGIN = "<!--maestro:begin-->";
const END = "<!--maestro:end-->";
const BLOCK = new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`);

const THEMES: CanvasTheme[] = ["maestro", "tailwind", "none"];

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

export function surfaceToHtml(surface: CanvasSurface): string {
  const meta = [
    `<title>${escapeAttribute(surface.title)}</title>`,
    `<meta name="maestro-surface" content="${escapeAttribute(surface.surfaceId)}">`,
    `<meta name="maestro-theme" content="${surface.theme}">`,
    `<meta name="maestro-sources" content="${escapeAttribute(surface.sources.join(" "))}">`,
    `<meta name="maestro-created" content="${surface.createdAt}">`,
    // `</` inside the JSON would end the script element early.
    `<script type="application/json" id="maestro-data">${JSON.stringify(surface.data).replace(
      /<\//g,
      "<\\/",
    )}</script>`,
  ].join("\n");
  return `${BEGIN}\n${meta}\n${END}\n${surface.html}`;
}

/** Null when the file was not written by `surfaceToHtml` — an older `.json`, or something else. */
export function surfaceFromHtml(file: string): CanvasSurface | null {
  const start = file.indexOf(BEGIN);
  const end = file.indexOf(END);
  if (start < 0 || end < start) return null;

  const block = new DOMParser().parseFromString(file.slice(start + BEGIN.length, end), "text/html");
  const meta = (name: string) =>
    block.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? "";
  const surfaceId = meta("maestro-surface");
  if (!surfaceId) return null;

  const theme = meta("maestro-theme") as CanvasTheme;
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(block.querySelector("#maestro-data")?.textContent || "{}");
  } catch {
    data = {};
  }

  return {
    surfaceId,
    title: block.querySelector("title")?.textContent ?? surfaceId,
    html: file.replace(BLOCK, ""),
    theme: THEMES.includes(theme) ? theme : "maestro",
    sources: meta("maestro-sources").split(/\s+/).filter(Boolean),
    data,
    // Absent in files written before surfaces recorded their order. Zero rather than `Date.now()`
    // so those sort together at the front instead of jumping ahead of everything drawn since.
    createdAt: Number(meta("maestro-created")) || 0,
  };
}

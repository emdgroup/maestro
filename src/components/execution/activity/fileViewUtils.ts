import { isImageExtension, langForExtension } from "./fileTypeUtils";

export type FileViewType = "markdown" | "svg" | "mermaid" | "code" | "html" | "plain" | "image";

export function getFileViewType(path: string): FileViewType {
  const dot = path.lastIndexOf(".");
  const ext = dot !== -1 ? path.slice(dot).toLowerCase() : "";
  if (ext === ".md") return "markdown";
  if (ext === ".svg") return "svg";
  if (ext === ".mmd" || ext === ".mermaid") return "mermaid";
  if (ext === ".html") return "html";
  if (isImageExtension(path)) return "image";
  if (ext === ".txt" || ext === ".log" || ext === ".csv" || ext === ".tsv") return "plain";
  if (langForExtension(path) !== undefined) return "code";
  return "plain";
}

export const IFRAME_SCROLLBAR_CSS = `<style>
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background-color: rgba(128,128,128,0.3); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background-color: rgba(128,128,128,0.5); }
html { scrollbar-width: thin; scrollbar-color: rgba(128,128,128,0.3) transparent; }
</style>`;

export function injectScrollbarCSS(html: string): string {
  if (html.includes("</head>")) return html.replace("</head>", `${IFRAME_SCROLLBAR_CSS}</head>`);
  return IFRAME_SCROLLBAR_CSS + html;
}

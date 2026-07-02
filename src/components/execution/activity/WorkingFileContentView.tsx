import { useState, useEffect, useMemo, useRef } from "react";
import { Copy, Check } from "lucide-react";
import { cn } from "@/lib/ui-utils";
import { api } from "@/lib/tauri-utils";
import { Slider } from "@/ui/slider";
import { MarkdownBlock, SvgBlock, MermaidBlock, HighlightedCode } from "./MarkdownBlock";
import { isImageExtension, imageMimeForExtension, langForExtension } from "./fileTypeUtils";

type FileViewType = "markdown" | "svg" | "mermaid" | "code" | "html" | "plain" | "image";

function getFileViewType(path: string): FileViewType {
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

const IFRAME_SCROLLBAR_CSS = `<style>
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background-color: rgba(128,128,128,0.3); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background-color: rgba(128,128,128,0.5); }
html { scrollbar-width: thin; scrollbar-color: rgba(128,128,128,0.3) transparent; }
</style>`;

function injectScrollbarCSS(html: string): string {
  if (html.includes("</head>")) return html.replace("</head>", `${IFRAME_SCROLLBAR_CSS}</head>`);
  return IFRAME_SCROLLBAR_CSS + html;
}

function FileContentInner({
  content,
  viewType,
  path,
}: {
  content: string;
  viewType: FileViewType;
  path: string;
}) {
  const lang = langForExtension(path) ?? "text";
  const blobUrl = useMemo(() => {
    if (viewType !== "html") return null;
    const blob = new Blob([injectScrollbarCSS(content)], { type: "text/html" });
    return URL.createObjectURL(blob);
  }, [content, viewType]);
  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  switch (viewType) {
    case "markdown":
      return <MarkdownBlock text={content} />;
    case "svg":
      return <SvgBlock code={content} />;
    case "mermaid":
      return <MermaidBlock code={content} />;
    case "html":
      return (
        <iframe
          src={blobUrl ?? undefined}
          sandbox="allow-scripts"
          className="w-full h-full border-0 bg-white rounded-md"
          title={path.split("/").pop()}
        />
      );
    case "plain":
      return (
        <pre className="text-xs font-mono whitespace-pre-wrap break-words text-foreground/80">
          {content}
        </pre>
      );
    case "code":
      return (
        <div className="file-code-view">
          <HighlightedCode code={content} lang={lang} />
        </div>
      );
    case "image": {
      const mime = imageMimeForExtension(path);
      return (
        <img
          src={`data:${mime};base64,${content}`}
          alt={path.split("/").pop() ?? ""}
          className="max-w-full rounded-md"
        />
      );
    }
    default:
      return null;
  }
}

interface WorkingFileContentViewProps {
  sessionKey: number;
  filePath: string | null;
  isActive?: boolean;
  zoom?: number;
  onZoomChange?: (z: number) => void;
}

export function WorkingFileContentView({
  sessionKey,
  filePath,
  isActive = true,
  zoom: zoomProp,
  onZoomChange,
}: WorkingFileContentViewProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [cwd, setCwd] = useState<string | null>(null);
  const [zoomState, setZoomState] = useState(100);
  const zoom = zoomProp ?? zoomState;
  const setZoom = onZoomChange ?? setZoomState;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => {
    if (!isActive) return;
    setRefreshTick((t) => t + 1);
    const id = setInterval(() => setRefreshTick((t) => t + 1), 3000);
    return () => clearInterval(id);
  }, [isActive]);

  useEffect(() => {
    api
      .getAcpSessionMeta(sessionKey)
      .then((meta) => setCwd(meta.cwd.replace(/\/+$/, "")))
      .catch((e) => setLoadError(String(e)));
  }, [sessionKey]);

  useEffect(() => {
    setZoom(100);
  }, [filePath]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        setZoom(Math.min(200, zoomRef.current + 10));
      } else if (e.key === "-") {
        e.preventDefault();
        setZoom(Math.max(50, zoomRef.current - 10));
      } else if (e.key === "0") {
        e.preventDefault();
        setZoom(100);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom(Math.min(200, Math.max(50, zoomRef.current + (e.deltaY < 0 ? 10 : -10))));
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const relativePath = useMemo(() => {
    if (!filePath) return null;
    if (cwd && filePath.startsWith(cwd + "/")) return filePath.slice(cwd.length + 1);
    if (filePath.startsWith("/")) return null;
    return filePath;
  }, [filePath, cwd]);

  const absolutePath = filePath
    ? filePath.startsWith("/")
      ? filePath
      : cwd
        ? `${cwd}/${filePath}`
        : null
    : null;

  const viewType = filePath ? getFileViewType(filePath) : null;
  const isBinary = viewType === "image";

  useEffect(() => {
    if (!relativePath) return;
    setLoading(true);
    setContent(null);
    setLoadError(null);
  }, [relativePath, sessionKey, isBinary]);

  useEffect(() => {
    if (!relativePath) return;
    const loader = isBinary
      ? api.readSessionFileBinary(sessionKey, relativePath)
      : api.readSessionFile(sessionKey, relativePath);
    loader
      .then((data) => {
        setLoading(false);
        setContent((prev) => (prev === data ? prev : data));
      })
      .catch((err) => {
        setLoadError(String(err));
        setLoading(false);
      });
  }, [relativePath, sessionKey, isBinary, refreshTick]);

  function copyPath() {
    if (!absolutePath) return;
    navigator.clipboard.writeText(absolutePath);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div ref={panelRef} className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
      {content !== null && viewType !== null && !onZoomChange && (
        <div className="flex items-center gap-2 px-3 py-1 border-b border-border bg-card/30 shrink-0">
          <div className="flex-1" />
          <Slider
            min={50}
            max={200}
            value={[zoom]}
            onValueChange={(val) => setZoom(Array.isArray(val) ? val[0] : (val as number))}
            className="zoom-slider w-16 shrink-0"
          />
          <button
            type="button"
            onClick={() => setZoom(100)}
            className="px-1 py-0.5 rounded text-[10px] font-mono text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors min-w-[2.5rem] text-center shrink-0"
          >
            {zoom}%
          </button>
        </div>
      )}
      <div
        className={cn(
          "flex-1 overflow-auto text-sm custom-scrollbar",
          viewType === "html" || viewType === "code" ? "p-0" : "px-6 py-5",
        )}
      >
        {loading && <div className="text-xs text-muted-foreground animate-pulse">Loading...</div>}
        {!loading && filePath && !relativePath && !loadError && (
          <div className="text-xs text-muted-foreground animate-pulse">Resolving path...</div>
        )}
        {!loading && !filePath && (
          <div className="text-xs text-muted-foreground">No file selected</div>
        )}
        {!loading && filePath && loadError && (
          <div className="text-xs text-destructive">{loadError}</div>
        )}
        {!loading && content !== null && viewType !== null && (
          <div
            style={{
              transform: zoom !== 100 ? `scale(${zoom / 100})` : undefined,
              transformOrigin: "top left",
              width: zoom !== 100 ? `${10000 / zoom}%` : undefined,
              height:
                viewType === "html" ? (zoom !== 100 ? `${10000 / zoom}%` : "100%") : undefined,
            }}
          >
            <FileContentInner content={content} viewType={viewType} path={filePath ?? ""} />
          </div>
        )}
      </div>
      {absolutePath && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-t border-border bg-card/30 shrink-0">
          <span className="flex-1 text-[10px] font-mono text-muted-foreground/70 truncate">
            {absolutePath}
          </span>
          <button
            type="button"
            onClick={copyPath}
            className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] border border-border rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0"
          >
            {copied ? <Check className="w-2.5 h-2.5" /> : <Copy className="w-2.5 h-2.5" />}
            {copied ? "Copied" : "Copy path"}
          </button>
        </div>
      )}
    </div>
  );
}

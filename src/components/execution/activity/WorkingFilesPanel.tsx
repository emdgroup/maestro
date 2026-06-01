import { useState, useEffect, useMemo, useRef } from "react";
import { FileText, X, Copy, Check, FileCode } from "lucide-react";
import { cn } from "@/lib/ui-utils";
import { api } from "@/lib/tauri-utils";
import { MarkdownBlock, SvgBlock, MermaidBlock, CodeBlockWrapper } from "./MarkdownBlock";
import { Slider } from "@/ui/slider";
import { isImageExtension, imageMimeForExtension, langForExtension } from "./file-type-utils";

interface WorkingFilesPanelProps {
  files: string[];
  sessionKey: number;
  onClose: () => void;
}

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

function injectIframeScrollbarCSS(html: string): string {
  if (html.includes("</head>")) {
    return html.replace("</head>", `${IFRAME_SCROLLBAR_CSS}</head>`);
  }
  return IFRAME_SCROLLBAR_CSS + html;
}

function FileContentView({
  content,
  viewType,
  path,
}: {
  content: string;
  viewType: FileViewType;
  path: string;
}) {
  const lang = langForExtension(path) ?? "text";

  // blob: URLs render in sandboxed iframe — CSP from tauri.conf.json still applies at webview level
  const blobUrl = useMemo(() => {
    if (viewType !== "html") return null;
    const html = injectIframeScrollbarCSS(content);
    const blob = new Blob([html], { type: "text/html" });
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
      return <CodeBlockWrapper code={content} lang={lang} />;
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

export function WorkingFilesPanel({ files, sessionKey, onClose }: WorkingFilesPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(files[0] ?? null);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [cwd, setCwd] = useState<string | null>(null);
  const [zoom, setZoom] = useState(100);

  useEffect(() => {
    api
      .getAcpSessionMeta(sessionKey)
      .then((meta) => setCwd(meta.cwd.replace(/\/+$/, "")))
      .catch(console.error);
  }, [sessionKey]);

  useEffect(() => {
    setZoom(100);
  }, [selectedFile]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        setZoom((z) => Math.min(200, z + 10));
      } else if (e.key === "-") {
        e.preventDefault();
        setZoom((z) => Math.max(50, z - 10));
      } else if (e.key === "0") {
        e.preventDefault();
        setZoom(100);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    function handleWheel(e: WheelEvent) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom((z) => Math.min(200, Math.max(50, z + (e.deltaY < 0 ? 10 : -10))));
    }
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, []);

  // Gate: return null when path is absolute but cwd not yet loaded to avoid sending absolute path to server
  const relativePath = useMemo(() => {
    if (!selectedFile) return null;
    if (cwd && selectedFile.startsWith(cwd + "/")) return selectedFile.slice(cwd.length + 1);
    if (selectedFile.startsWith("/")) return null;
    return selectedFile;
  }, [selectedFile, cwd]);

  // Absolute path for display: use as-is if already absolute, else prepend cwd
  const absolutePath = selectedFile
    ? selectedFile.startsWith("/")
      ? selectedFile
      : cwd
        ? `${cwd}/${selectedFile}`
        : null
    : null;

  const viewType = selectedFile ? getFileViewType(selectedFile) : null;
  const isBinary = viewType === "image";

  useEffect(() => {
    if (!relativePath) return;
    setLoading(true);
    setContent(null);
    setLoadError(null);
    const loader = isBinary
      ? api.readSessionFileBinary(sessionKey, relativePath)
      : api.readSessionFile(sessionKey, relativePath);
    loader
      .then((data) => {
        setLoading(false);
        setContent(data);
      })
      .catch((err) => {
        console.error(err);
        setLoadError(String(err));
        setLoading(false);
      });
  }, [relativePath, sessionKey, isBinary]);

  function copyPath() {
    if (!absolutePath) return;
    navigator.clipboard.writeText(absolutePath);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const basename = selectedFile ? (selectedFile.split("/").pop() ?? selectedFile) : null;

  return (
    <div ref={panelRef} className="absolute inset-0 z-50 flex flex-col bg-background">
      {/* Header */}
      <div className="flex items-center h-12 px-4 border-b border-border bg-card/50 shrink-0 gap-2">
        <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
        <span className="text-sm font-semibold">Working Files</span>
        {basename && (
          <>
            <div className="w-px h-4 bg-border shrink-0" />
            <span className="text-xs font-mono text-muted-foreground truncate">{basename}</span>
          </>
        )}
        <div className="flex-1" />
        {content !== null && viewType !== null && (
          <div className="flex items-center gap-2 shrink-0">
            <Slider
              min={50}
              max={200}
              value={[zoom]}
              onValueChange={(val) => setZoom(Array.isArray(val) ? val[0] : (val as number))}
              className="zoom-slider w-20"
            />
            <button
              type="button"
              onClick={() => setZoom(100)}
              className="px-1.5 py-0.5 rounded text-[10px] font-mono text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors min-w-[3rem] text-center"
            >
              {zoom}%
            </button>
            <div className="w-px h-4 bg-border shrink-0" />
          </div>
        )}
        <button
          type="button"
          onClick={onClose}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Body */}
      <div className="flex flex-1 min-h-0">
        {/* File list */}
        <div className="w-56 shrink-0 border-r border-border overflow-y-auto flex flex-col custom-scrollbar">
          {files.map((file) => {
            const name = file.split("/").pop() ?? file;
            return (
              <button
                key={file}
                type="button"
                onClick={() => setSelectedFile(file)}
                className={cn(
                  "flex items-center gap-2 px-3 py-2 text-left border-l-2 transition-colors",
                  file === selectedFile
                    ? "border-ring bg-muted/20 text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-muted/10 hover:text-foreground",
                )}
              >
                <FileCode className="w-3.5 h-3.5 shrink-0 opacity-60" />
                <span className="text-xs truncate">{name}</span>
              </button>
            );
          })}
        </div>

        {/* Content viewer */}
        <div className="flex-1 flex flex-col min-w-0">
          <div
            className={cn(
              "flex-1 overflow-auto text-sm custom-scrollbar",
              viewType === "html" ? "p-0" : "px-6 py-5",
            )}
          >
            {loading && (
              <div className="text-xs text-muted-foreground animate-pulse">Loading...</div>
            )}
            {!loading && selectedFile && !relativePath && !loadError && (
              <div className="text-xs text-muted-foreground animate-pulse">Resolving path...</div>
            )}
            {!loading && !selectedFile && (
              <div className="text-xs text-muted-foreground">No file selected</div>
            )}
            {!loading && selectedFile && loadError && (
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
                <FileContentView content={content} viewType={viewType} path={selectedFile ?? ""} />
              </div>
            )}
          </div>

          {/* Path bar */}
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
      </div>
    </div>
  );
}

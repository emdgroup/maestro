import { useState, useEffect, useMemo } from "react";
import { FileText, X, Copy, Check, FileCode } from "lucide-react";
import { cn } from "@/lib/ui-utils";
import { api } from "@/lib/tauri-utils";
import { MarkdownBlock } from "./MarkdownBlock";

interface WorkingFilesPanelProps {
  files: string[];
  sessionKey: number;
  onClose: () => void;
}

export function WorkingFilesPanel({ files, sessionKey, onClose }: WorkingFilesPanelProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(files[0] ?? null);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [cwd, setCwd] = useState<string | null>(null);

  useEffect(() => {
    api.getAcpSessionMeta(sessionKey).then((meta) => setCwd(meta.cwd)).catch(console.error);
  }, [sessionKey]);

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
      : cwd ? `${cwd}/${selectedFile}` : null
    : null;

  useEffect(() => {
    if (!relativePath) return;
    setLoading(true);
    setContent(null);
    setLoadError(null);
    api.readSessionFile(sessionKey, relativePath).then((text) => {
      setLoading(false);
      setContent(text);
    }).catch((err) => {
      console.error(err);
      setLoadError(String(err));
      setLoading(false);
    });
  }, [relativePath, sessionKey]);

  function copyPath() {
    if (!absolutePath) return;
    navigator.clipboard.writeText(absolutePath);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const basename = selectedFile ? (selectedFile.split("/").pop() ?? selectedFile) : null;

  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-background">
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
        <button
          type="button"
          onClick={onClose}
          className="ml-auto p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0"
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
          <div className="flex-1 overflow-auto px-6 py-5 text-sm custom-scrollbar">
            {loading && (
              <div className="text-xs text-muted-foreground animate-pulse">Loading...</div>
            )}
            {!loading && content === null && !selectedFile && (
              <div className="text-xs text-muted-foreground">No file selected</div>
            )}
            {!loading && content === null && selectedFile && loadError && (
              <div className="text-xs text-destructive">{loadError}</div>
            )}
            {!loading && content !== null && (
              <MarkdownBlock text={content} />
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

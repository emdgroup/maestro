import { useState, useEffect, useMemo } from "react";
import { Files, ExternalLink } from "lucide-react";
import { cn } from "@/lib/ui-utils";
import { Slider } from "@/ui/slider";
import { FileSelector } from "@/components/execution/diff/FileSelector";
import { WorkingFileContentView } from "@/components/execution/activity/WorkingFileContentView";
import { api } from "@/lib/tauri-utils";
import { openFileWithConnection } from "@/lib/file-opener";
import type { ConnectionKey } from "@/types/bindings";

interface ArtifactsPanelProps {
  files: string[];
  sessionKey: number;
  connection: ConnectionKey;
  wslDistroName?: string;
  isActive?: boolean;
}

export function ArtifactsPanel({
  files,
  sessionKey,
  connection,
  wslDistroName,
  isActive = true,
}: ArtifactsPanelProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [cwd, setCwd] = useState<string | null>(null);

  useEffect(() => {
    api
      .getAcpSessionMeta(sessionKey)
      .then((m) => setCwd(m.cwd.replace(/\/+$/, "")))
      .catch(() => {});
  }, [sessionKey]);

  const relativeFiles = useMemo(
    () => files.map((f) => (cwd && f.startsWith(cwd + "/") ? f.slice(cwd.length + 1) : f)),
    [files, cwd],
  );

  const selectedAbsPath = useMemo(() => {
    if (!selected) return null;
    const idx = relativeFiles.indexOf(selected);
    return idx >= 0 ? (files[idx] ?? null) : null;
  }, [selected, relativeFiles, files]);

  useEffect(() => {
    if (selected === null && relativeFiles.length > 0) setSelected(relativeFiles[0]);
  }, [relativeFiles, selected]);

  const basename = selected ? (selected.split("/").pop() ?? selected) : null;

  return (
    <div className="relative flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center h-10 px-2 border-b border-border bg-card/50 shrink-0 gap-1">
        <button
          type="button"
          onClick={() => setListOpen((v) => !v)}
          className={cn(
            "p-1.5 rounded-md transition-colors shrink-0",
            listOpen
              ? "text-foreground bg-muted/60"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
          )}
          title="File list"
        >
          <Files className="w-4 h-4" />
        </button>
        <div className="w-px h-4 bg-border shrink-0 mx-1" />
        <div className="flex-1 flex items-center justify-center min-w-0">
          <span className="text-xs font-mono text-muted-foreground truncate">
            {basename ?? "No file selected"}
          </span>
        </div>
        {selected !== null && (
          <>
            <div className="w-px h-4 bg-border shrink-0 mx-1" />
            <Slider
              min={50}
              max={200}
              value={[zoom]}
              onValueChange={(v) => setZoom(Array.isArray(v) ? v[0] : (v as number))}
              className="zoom-slider w-16 shrink-0"
            />
            <button
              type="button"
              onClick={() => setZoom(100)}
              className="px-1 py-0.5 rounded text-[10px] font-mono text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors min-w-[2.5rem] text-center shrink-0"
            >
              {zoom}%
            </button>
            <div className="w-px h-4 bg-border shrink-0 mx-1" />
            <button
              type="button"
              onClick={() => {
                if (selectedAbsPath)
                  void openFileWithConnection(connection, selectedAbsPath, { wslDistroName });
              }}
              className="p-1.5 rounded-md transition-colors shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted/60"
              title="Open in default application"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </button>
          </>
        )}
      </div>

      {/* File list overlay */}
      {listOpen && (
        <>
          <div
            className="absolute inset-x-0 bottom-0 z-10 bg-background border-r border-border flex flex-col"
            style={{ top: "2.5rem", width: "14rem" }}
          >
            <FileSelector
              files={relativeFiles.map((f) => ({ fileName: f }))}
              selectedFile={selected}
              onSelectFile={(f) => {
                setSelected(f);
                setListOpen(false);
              }}
              className="flex-1 min-h-0"
            />
          </div>
          <div
            className="absolute inset-0 z-9"
            style={{ top: "2.5rem" }}
            onClick={() => setListOpen(false)}
          />
        </>
      )}

      {/* Content */}
      <WorkingFileContentView
        sessionKey={sessionKey}
        filePath={selected}
        isActive={isActive}
        zoom={zoom}
        onZoomChange={setZoom}
      />
    </div>
  );
}

import { useState, useEffect, useMemo } from "react";
import { Files, ExternalLink, X } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { cn } from "@/lib/utils.ts";
import { Slider } from "@/ui/slider";
import { FileSelector } from "@/components/execution/diff/FileSelector";
import { WorkingFileContentView } from "@/components/execution/activity/WorkingFileContentView";
import { api } from "@/lib/tauri-utils";
import { openFileWithConnection } from "@/lib/file-opener";
import type { ConnectionKey } from "@/types/bindings";

type DlState =
  | { status: "idle" }
  | { status: "downloading"; progress: number }
  | { status: "error" };

interface ArtifactsPanelProps {
  files: string[];
  sessionKey: number;
  connection: ConnectionKey;
  wslDistroName?: string;
  isActive?: boolean;
  initialFile?: string | null;
}

export function ArtifactsPanel({
  files,
  sessionKey,
  connection,
  wslDistroName,
  isActive = true,
  initialFile,
}: ArtifactsPanelProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [cwd, setCwd] = useState<string | null>(null);
  const [dlState, setDlState] = useState<DlState>({ status: "idle" });

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

  useEffect(() => {
    if (!initialFile) return;
    const idx = files.indexOf(initialFile);
    if (idx >= 0 && relativeFiles[idx]) setSelected(relativeFiles[idx]);
  }, [initialFile, files, relativeFiles]);

  const basename = selected ? (selected.split("/").pop() ?? selected) : null;

  async function handleOpen() {
    if (!selectedAbsPath || dlState.status === "downloading") return;
    if (connection.type !== "ssh") {
      try {
        await openFileWithConnection(connection, selectedAbsPath, { wslDistroName });
      } catch {
        setDlState({ status: "error" });
        setTimeout(() => setDlState({ status: "idle" }), 2000);
      }
      return;
    }
    const transferId = `open-${Date.now()}`;
    setDlState({ status: "downloading", progress: 0 });
    const unlisten = await listen<{ bytes_transferred: number; total_bytes: number }>(
      `sftp://transfer-progress/${transferId}`,
      (e) => {
        const pct =
          e.payload.total_bytes > 0
            ? Math.round((e.payload.bytes_transferred / e.payload.total_bytes) * 100)
            : 0;
        setDlState({ status: "downloading", progress: pct });
      },
    );
    try {
      await openFileWithConnection(connection, selectedAbsPath, {
        sshConnectionId: connection.id,
        transferId,
        wslDistroName,
      });
      setDlState({ status: "idle" });
    } catch {
      setDlState({ status: "error" });
      setTimeout(() => setDlState({ status: "idle" }), 2000);
    } finally {
      unlisten();
    }
  }

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
              onClick={() => void handleOpen()}
              disabled={dlState.status === "downloading"}
              className={cn(
                "p-1.5 rounded-md transition-colors shrink-0",
                dlState.status === "error"
                  ? "text-destructive"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
              )}
              title={
                dlState.status === "error"
                  ? "Failed to open"
                  : connection.type === "ssh"
                    ? "Download and open"
                    : "Open in default application"
              }
            >
              {dlState.status === "downloading" ? (
                <span className="text-[9px] font-mono leading-none tabular-nums w-5 inline-block text-center">
                  {dlState.progress}%
                </span>
              ) : dlState.status === "error" ? (
                <X className="w-3.5 h-3.5" />
              ) : (
                <ExternalLink className="w-3.5 h-3.5" />
              )}
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

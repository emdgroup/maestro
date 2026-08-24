import { useState, useMemo } from "react";
import { Files, ExternalLink, FolderDown } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { Slider } from "@/ui/slider";
import { FileSelector } from "@/components/execution/diff/FileSelector";
import { WorkingFileContentView } from "@/components/execution/activity/WorkingFileContentView";
import { useAcpSessionMeta } from "@/services/execution.service";
import { openFileWithConnection, downloadFileToFolder, opensViaHostCopy } from "@/lib/file-opener";
import type { ConnectionKey } from "@/types/bindings";
import { TransferIcon } from "./TransferIcon";
import { transferTooltip, useFileTransfer } from "./useFileTransfer";

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
  // Null until the user picks a file; the effective selection is resolved during render.
  const [pickedFile, setPickedFile] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [zoom, setZoom] = useState(100);
  const openTransfer = useFileTransfer();
  const downloadTransfer = useFileTransfer();
  const { data: sessionMeta } = useAcpSessionMeta(sessionKey ?? null);
  const cwd = sessionMeta ? sessionMeta.cwd.replace(/\/+$/, "") : null;

  const relativeFiles = useMemo(
    () => files.map((f) => (cwd && f.startsWith(cwd + "/") ? f.slice(cwd.length + 1) : f)),
    [files, cwd],
  );

  // Precedence: what the user picked, else the file the caller asked to open, else the
  // first one. Resolved during render rather than written back from effects, which had to
  // guard themselves with a ref to avoid re-applying `initialFile` over a later click.
  const requestedFile = initialFile ? (relativeFiles[files.indexOf(initialFile)] ?? null) : null;
  const selected = pickedFile ?? requestedFile ?? relativeFiles[0] ?? null;

  const selectedAbsPath = useMemo(() => {
    if (!selected) return null;
    const idx = relativeFiles.indexOf(selected);
    return idx >= 0 ? (files[idx] ?? null) : null;
  }, [selected, relativeFiles, files]);

  const basename = selected ? (selected.split("/").pop() ?? selected) : null;

  async function handleOpen() {
    if (!selectedAbsPath) return;
    const transferId = `open-${Date.now()}`;
    await openTransfer.run({
      transferId,
      reportsProgress: connection.type === "ssh",
      action: () =>
        openFileWithConnection(connection, selectedAbsPath, {
          sshConnectionId: connection.type === "ssh" ? connection.id : undefined,
          transferId,
          wslDistroName,
        }),
      // The file opening is its own confirmation, so success stays quiet here.
    });
  }

  async function handleDownload() {
    if (!selectedAbsPath || connection.type === "local") return;
    const transferId = `dl-${Date.now()}`;
    await downloadTransfer.run({
      transferId,
      reportsProgress: connection.type === "ssh",
      action: () => downloadFileToFolder(connection, selectedAbsPath, transferId),
      describeDone: (dest) => (dest === null ? null : `Saved to ${dest}`),
    });
  }

  return (
    <div className="relative flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center h-10 px-2 border-b border-border bg-card/50 shrink-0 gap-1">
        <Tooltip>
          <TooltipTrigger
            type="button"
            onClick={() => setListOpen((v) => !v)}
            className={cn(
              "p-1.5 rounded-md transition-colors shrink-0",
              listOpen
                ? "text-foreground bg-muted/60"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
            )}
          >
            <Files className="w-4 h-4" />
          </TooltipTrigger>
          <TooltipContent>File list</TooltipContent>
        </Tooltip>
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
            <Tooltip>
              <TooltipTrigger
                type="button"
                onClick={() => void handleOpen()}
                disabled={openTransfer.pending}
                className={cn(
                  "p-1.5 rounded-md transition-colors shrink-0",
                  openTransfer.state.status === "error"
                    ? "text-destructive"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
                )}
              >
                <TransferIcon
                  state={openTransfer.state}
                  idle={<ExternalLink className="w-3.5 h-3.5" />}
                />
              </TooltipTrigger>
              <TooltipContent>
                {transferTooltip(
                  openTransfer.state,
                  opensViaHostCopy(connection)
                    ? "Download and open"
                    : "Open in default application",
                )}
              </TooltipContent>
            </Tooltip>
            {connection.type !== "local" && (
              <Tooltip>
                <TooltipTrigger
                  type="button"
                  onClick={() => void handleDownload()}
                  disabled={downloadTransfer.pending}
                  className={cn(
                    "p-1.5 rounded-md transition-colors shrink-0",
                    downloadTransfer.state.status === "error"
                      ? "text-destructive"
                      : downloadTransfer.state.status === "done"
                        ? "text-emerald-600"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
                  )}
                >
                  <TransferIcon
                    state={downloadTransfer.state}
                    idle={<FolderDown className="w-3.5 h-3.5" />}
                  />
                </TooltipTrigger>
                <TooltipContent>
                  {transferTooltip(downloadTransfer.state, "Download to…")}
                </TooltipContent>
              </Tooltip>
            )}
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
                setPickedFile(f);
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
        connection={connection}
        filePath={selected}
        isActive={isActive}
        zoom={zoom}
        onZoomChange={setZoom}
      />
    </div>
  );
}

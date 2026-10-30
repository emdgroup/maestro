import { useState, useMemo } from "react";
import { PanelLeft, ExternalLink, FolderDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Slider } from "@/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { CopyStateIcon, useCopyToClipboard } from "@/components/execution/activity/HighlightedCode";
import { ReviewLayout } from "@/components/execution/diff/ReviewLayout";
import { useReviewPanelLayout } from "@/components/execution/diff/useReviewPanelLayout";
import { WorkingFileContentView } from "@/components/execution/activity/WorkingFileContentView";
import { useAcpSessionMeta } from "@/services/execution.service";
import { openFileWithConnection, downloadFileToFolder, opensViaHostCopy } from "@/lib/file-opener";
import type { ConnectionKey } from "@/types/bindings";
import { ToolbarButton } from "./ToolbarButton";
import { TransferIcon } from "./TransferIcon";
import { transferTooltip, useFileTransfer } from "./useFileTransfer";

interface ArtifactsPanelProps {
  files: string[];
  sessionId: string;
  connection: ConnectionKey;
  wslDistroName?: string;
  isActive?: boolean;
  initialFile?: string | null;
}

export function ArtifactsPanel({
  files,
  sessionId,
  connection,
  wslDistroName,
  isActive = true,
  initialFile,
}: ArtifactsPanelProps) {
  // Null until the user picks a file; the effective selection is resolved during render.
  const [pickedFile, setPickedFile] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const panel = useReviewPanelLayout("artifacts");
  const [zoom, setZoom] = useState(100);
  const openTransfer = useFileTransfer();
  const downloadTransfer = useFileTransfer();
  const { data: sessionMeta } = useAcpSessionMeta(sessionId ?? null);
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
  const absolutePath =
    selectedAbsPath && cwd && !/^([a-zA-Z]:)?[\\/]/.test(selectedAbsPath)
      ? `${cwd}/${selectedAbsPath}`
      : selectedAbsPath;
  const { copied, copy: copyPath } = useCopyToClipboard(absolutePath ?? "");

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
    <div className="absolute inset-0 flex flex-col">
      {/* The Files tab's header, on the same surface as the file panel below it. */}
      <div className={cn("flex items-center h-10 px-2 shrink-0 gap-1", panel.inset && "mt-2")}>
        <ToolbarButton
          label={panel.panelOpen ? "Hide file list" : "Show file list"}
          active={panel.panelOpen}
          onClick={() => panel.setPanelOpen(!panel.panelOpen)}
        >
          <PanelLeft className="size-4" />
        </ToolbarButton>
        {/* As the Files tab: clicking the name copies the absolute path. */}
        <div className="flex-1 flex items-center justify-center gap-1.5 min-w-0 overflow-hidden">
          {basename ? (
            <Tooltip trackCursorAxis="x">
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={copyPath}
                    className="group/name flex items-center gap-1 min-w-0 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors"
                  />
                }
              >
                <span className="truncate">{basename}</span>
                <CopyStateIcon
                  copied={copied}
                  className={cn(
                    "size-3 shrink-0",
                    !copied &&
                      "opacity-0 group-hover/name:opacity-100 group-focus-visible/name:opacity-100 transition-opacity",
                  )}
                />
              </TooltipTrigger>
              <TooltipContent className="max-w-md break-all">{selected}</TooltipContent>
            </Tooltip>
          ) : (
            <span className="text-xs text-muted-foreground truncate">No file selected</span>
          )}
        </div>
        {selected !== null && (
          <>
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
              className="px-1 py-0.5 rounded text-[10px] font-mono text-muted-foreground hover:text-foreground hover:bg-foreground/7 transition-colors min-w-[2.5rem] text-center shrink-0"
            >
              {zoom}%
            </button>
            <ToolbarButton
              label={
                opensViaHostCopy(connection) ? "Download and open" : "Open in default application"
              }
              tooltip={transferTooltip(
                openTransfer.state,
                opensViaHostCopy(connection) ? "Download and open" : "Open in default application",
              )}
              disabled={openTransfer.pending}
              onClick={() => void handleOpen()}
              className={cn(openTransfer.state.status === "error" && "text-destructive")}
            >
              <TransferIcon
                state={openTransfer.state}
                idle={<ExternalLink className="size-3.5" />}
              />
            </ToolbarButton>
            {connection.type !== "local" && (
              <ToolbarButton
                label="Download to…"
                tooltip={transferTooltip(downloadTransfer.state, "Download to…")}
                disabled={downloadTransfer.pending}
                onClick={() => void handleDownload()}
                className={cn(
                  downloadTransfer.state.status === "error" && "text-destructive",
                  downloadTransfer.state.status === "done" && "text-emerald-600",
                )}
              >
                <TransferIcon
                  state={downloadTransfer.state}
                  idle={<FolderDown className="size-3.5" />}
                />
              </ToolbarButton>
            )}
          </>
        )}
      </div>

      <ReviewLayout
        panel={panel}
        files={{
          files: relativeFiles.map((f) => ({ fileName: f })),
          selectedFile: selected,
          onSelectFile: setPickedFile,
          search,
          onSearchChange: setSearch,
        }}
      >
        <WorkingFileContentView
          sessionId={sessionId}
          connection={connection}
          filePath={selected}
          isActive={isActive}
          zoom={zoom}
          onZoomChange={setZoom}
        />
      </ReviewLayout>
    </div>
  );
}

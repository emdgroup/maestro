import { useState, useMemo } from "react";
import { PanelLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { Slider } from "@/ui/slider";

import { ReviewLayout } from "@/components/execution/diff/ReviewLayout";
import { useReviewPanelLayout } from "@/components/execution/diff/useReviewPanelLayout";
import { WorkingFileContentView } from "@/components/execution/activity/WorkingFileContentView";
import { useAcpSessionMeta } from "@/services/execution.service";

import type { ConnectionKey } from "@/types/bindings";
import { ToolbarButton } from "./ToolbarButton";
import { FileHeaderActions, FileNameCopyButton } from "./FileHeaderActions";
import { basename } from "@/lib/path-utils";

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

  const fileName = selected ? basename(selected) : null;
  const absolutePath =
    selectedAbsPath && cwd && !/^([a-zA-Z]:)?[\\/]/.test(selectedAbsPath)
      ? `${cwd}/${selectedAbsPath}`
      : selectedAbsPath;

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
          {fileName && selected ? (
            <FileNameCopyButton
              fileName={fileName}
              title={selected}
              absolutePath={absolutePath ?? ""}
            />
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
            <FileHeaderActions
              connection={connection}
              path={selectedAbsPath}
              wslDistroName={wslDistroName}
            />
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

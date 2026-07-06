import { useState, useEffect, useRef } from "react";
import { Files, Pin, Loader2, ExternalLink, X } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { cn } from "@/lib/utils.ts";
import { FileSelector } from "@/components/execution/diff/FileSelector";
import { useListWorkspaceFiles, useReadFile } from "@/services/connection.service";
import type { ConnectionKey } from "@/types/bindings";
import { WorkspaceFileContent } from "./WorkspaceFileContent";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { openFileWithConnection } from "@/lib/file-opener";

interface WorkspaceFilesPanelProps {
  projectPath: string;
  connection: ConnectionKey;
  wslDistroName?: string;
  isActive?: boolean;
  initialPath?: string;
}

type DlState =
  | { status: "idle" }
  | { status: "downloading"; progress: number }
  | { status: "error" };

export function WorkspaceFilesPanel({
  projectPath,
  connection,
  wslDistroName,
  isActive = true,
  initialPath,
}: WorkspaceFilesPanelProps) {
  const [selected, setSelected] = useState<string | null>(initialPath ?? null);
  const [listOpen, setListOpen] = useState(true);
  const [listPinned, setListPinned] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [dlState, setDlState] = useState<DlState>({ status: "idle" });
  const [pinnedInitialSize, setPinnedInitialSize] = useState(224);
  const treeRef = useRef<HTMLDivElement>(null);

  const { data: allFiles = [], isLoading } = useListWorkspaceFiles(connection, projectPath);
  const fullPath = selected ? `${projectPath}/${selected}` : null;
  const {
    data: content,
    isLoading: contentLoading,
    error: contentError,
    refetch,
  } = useReadFile(connection, fullPath, { refetchInterval: isActive ? 3000 : undefined });

  useEffect(() => {
    if (isActive && fullPath) void refetch();
  }, [isActive, fullPath, refetch]);

  const showList = listOpen || listPinned;

  useEffect(() => {
    if (!showList || !selected) return;
    const id = setTimeout(() => {
      treeRef.current
        ?.querySelector(".selected-file-item")
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 50);
    return () => clearTimeout(id);
  }, [showList, selected]);

  const basename = selected ? (selected.split("/").pop() ?? selected) : null;

  function toggleList() {
    if (listPinned) {
      setListPinned(false);
      setListOpen(false);
    } else {
      setListOpen((v) => !v);
    }
  }

  function handleExpandedFoldersChange(folders: Set<string>) {
    setExpandedFolders(folders);
  }

  async function handleOpen() {
    if (!fullPath || dlState.status === "downloading") return;

    if (connection.type !== "ssh") {
      try {
        await openFileWithConnection(connection, fullPath, { wslDistroName });
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
      await openFileWithConnection(connection, fullPath, {
        sshConnectionId: connection.id,
        transferId,
      });
      setDlState({ status: "idle" });
    } catch {
      setDlState({ status: "error" });
      setTimeout(() => setDlState({ status: "idle" }), 2000);
    } finally {
      unlisten();
    }
  }

  const pinButton = (
    <button
      type="button"
      onClick={() => {
        if (!listPinned && treeRef.current) {
          setPinnedInitialSize(treeRef.current.offsetWidth);
        }
        setListPinned((v) => !v);
        setListOpen(false);
      }}
      className={cn(
        "p-1.5 rounded-md transition-colors shrink-0",
        listPinned
          ? "text-foreground bg-muted/60"
          : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
      )}
      title={listPinned ? "Unpin file list" : "Pin file list"}
    >
      <Pin className="w-3.5 h-3.5" />
    </button>
  );

  return (
    <div className="relative flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center h-10 px-2 border-b border-border bg-card/50 shrink-0 gap-1">
        <button
          type="button"
          onClick={toggleList}
          className={cn(
            "p-1.5 rounded-md transition-colors shrink-0",
            showList
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
        {selected && (
          <>
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
                  ? "Download failed"
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

      {/* Body */}
      {listPinned ? (
        <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0 overflow-hidden">
          <ResizablePanel
            defaultSize={pinnedInitialSize}
            minSize="8rem"
            maxSize="60%"
            className="flex flex-col min-h-0"
          >
            <div ref={treeRef} className="flex flex-col h-full min-h-0">
              {isLoading ? (
                <div className="flex flex-1 items-center justify-center">
                  <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <FileSelector
                  files={allFiles.map((f) => ({ fileName: f }))}
                  selectedFile={selected}
                  onSelectFile={setSelected}
                  treeOnly
                  treeDefaultExpanded={false}
                  headerRight={pinButton}
                  className="flex-1 min-h-0"
                  expandedFolders={expandedFolders}
                  onExpandedFoldersChange={handleExpandedFoldersChange}
                />
              )}
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel className="flex flex-col min-h-0">
            <WorkspaceFileContent
              content={content ?? null}
              isLoading={contentLoading}
              error={contentError ? String(contentError) : null}
              fileName={selected}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <div className="flex flex-1 min-h-0 relative">
          {/* Overlay: shown when open but not pinned */}
          {listOpen && (
            <>
              <div
                ref={treeRef}
                className="absolute inset-y-0 left-0 z-10 w-auto min-w-44 max-w-72 bg-background border-r border-border flex flex-col min-h-0"
              >
                {isLoading ? (
                  <div className="flex flex-1 items-center justify-center">
                    <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <FileSelector
                    files={allFiles.map((f) => ({ fileName: f }))}
                    selectedFile={selected}
                    onSelectFile={(f) => {
                      setSelected(f);
                      setListOpen(false);
                    }}
                    treeOnly
                    treeDefaultExpanded={false}
                    headerRight={pinButton}
                    className="flex-1 min-h-0"
                    expandedFolders={expandedFolders}
                    onExpandedFoldersChange={handleExpandedFoldersChange}
                  />
                )}
              </div>
              <div className="absolute inset-0 z-9" onClick={() => setListOpen(false)} />
            </>
          )}

          <WorkspaceFileContent
            content={content ?? null}
            isLoading={contentLoading}
            error={contentError ? String(contentError) : null}
            fileName={selected}
          />
        </div>
      )}
    </div>
  );
}

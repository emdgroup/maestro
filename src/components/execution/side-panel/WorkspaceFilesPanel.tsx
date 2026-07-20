import { useState, useEffect, useRef } from "react";
import { Files, Pin, ExternalLink, X, RefreshCw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { cn } from "@/lib/utils.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { connectionQueryKeys, useReadFile, useReadFileBinary } from "@/services/connection.service";
import { binaryMimeForExtension } from "@/components/execution/activity/fileTypeUtils";
import { LazyFileTree } from "./LazyFileTree";
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
  const [listOpen, setListOpen] = useState(!initialPath);
  const [listPinned, setListPinned] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [dlState, setDlState] = useState<DlState>({ status: "idle" });
  const [pinnedInitialSize, setPinnedInitialSize] = useState(224);
  const treeRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const fullPath = selected ? `${projectPath}/${selected}` : null;
  const fileDir = fullPath ? fullPath.replace(/\/[^/]+$/, "") : undefined;
  const binaryMime = selected ? binaryMimeForExtension(selected) : undefined;
  const {
    data: content,
    isLoading: contentLoading,
    error: contentError,
    refetch,
  } = useReadFile(connection, binaryMime ? null : fullPath, {
    refetchInterval: (query) => (query.state.error ? false : isActive ? 3000 : false),
  });
  const {
    data: binaryContent,
    isLoading: binaryLoading,
    error: binaryError,
  } = useReadFileBinary(connection, binaryMime ? fullPath : null);

  useEffect(() => {
    if (isActive && fullPath && !binaryMime) {
      void refetch();
    }
  }, [isActive, fullPath, binaryMime, refetch]);

  // Invalidate all cached dir listings for this connection when tab regains focus.
  // Only mounted queries (root + expanded dirs) will actually refetch.
  useEffect(() => {
    if (!isActive) return;
    void queryClient.invalidateQueries({
      queryKey: [...connectionQueryKeys.fileBrowser(), "dir", connection],
    });
  }, [isActive, queryClient, connection]);

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

  function handleRefresh() {
    void queryClient.invalidateQueries({
      queryKey: [...connectionQueryKeys.fileBrowser(), "dir", connection],
    });
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
    <Tooltip>
      <TooltipTrigger
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
      >
        <Pin className="w-3.5 h-3.5" />
      </TooltipTrigger>
      <TooltipContent>{listPinned ? "Unpin file list" : "Pin file list"}</TooltipContent>
    </Tooltip>
  );

  const refreshButton = (
    <Tooltip>
      <TooltipTrigger
        type="button"
        onClick={handleRefresh}
        className="p-1.5 rounded-md transition-colors shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted/60"
      >
        <RefreshCw className="w-3.5 h-3.5" />
      </TooltipTrigger>
      <TooltipContent>Refresh files</TooltipContent>
    </Tooltip>
  );

  const fileListActions = (
    <>
      {pinButton}
      {refreshButton}
    </>
  );

  const lazyTree = (
    <LazyFileTree
      root={projectPath}
      connection={connection}
      wslDistroName={wslDistroName}
      selectedFile={selected}
      onSelectFile={setSelected}
      expandedFolders={expandedFolders}
      onExpandedFoldersChange={setExpandedFolders}
      headerRight={fileListActions}
      className="flex-1 min-h-0"
    />
  );

  return (
    <div className="relative flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center h-10 px-2 border-b border-border bg-card/50 shrink-0 gap-1">
        <Tooltip>
          <TooltipTrigger
            type="button"
            onClick={toggleList}
            className={cn(
              "p-1.5 rounded-md transition-colors shrink-0",
              showList
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
        {selected && (
          <>
            <div className="w-px h-4 bg-border shrink-0 mx-1" />
            <Tooltip>
              <TooltipTrigger
                type="button"
                onClick={() => void handleOpen()}
                disabled={dlState.status === "downloading"}
                className={cn(
                  "p-1.5 rounded-md transition-colors shrink-0",
                  dlState.status === "error"
                    ? "text-destructive"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
                )}
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
              </TooltipTrigger>
              <TooltipContent>
                {dlState.status === "error"
                  ? "Download failed"
                  : connection.type === "ssh"
                    ? "Download and open"
                    : "Open in default application"}
              </TooltipContent>
            </Tooltip>
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
              {lazyTree}
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel className="flex flex-col min-h-0">
            <WorkspaceFileContent
              content={binaryMime ? (binaryContent ?? null) : (content ?? null)}
              isLoading={binaryMime ? binaryLoading : contentLoading}
              error={
                binaryMime
                  ? binaryError
                    ? String(binaryError)
                    : null
                  : contentError
                    ? String(contentError)
                    : null
              }
              fileName={selected}
              mimeType={binaryMime}
              fileDir={fileDir}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <div className="flex flex-1 min-h-0 relative">
          {listOpen && (
            <>
              <div
                ref={treeRef}
                className="absolute inset-y-0 left-0 z-10 w-auto min-w-44 max-w-72 bg-background border-r border-border flex flex-col min-h-0"
              >
                {lazyTree}
              </div>
              <div className="absolute inset-0 z-9" onClick={() => setListOpen(false)} />
            </>
          )}

          <WorkspaceFileContent
            content={binaryMime ? (binaryContent ?? null) : (content ?? null)}
            isLoading={binaryMime ? binaryLoading : contentLoading}
            error={
              binaryMime
                ? binaryError
                  ? String(binaryError)
                  : null
                : contentError
                  ? String(contentError)
                  : null
            }
            fileName={selected}
            mimeType={binaryMime}
            fileDir={fileDir}
          />
        </div>
      )}
    </div>
  );
}

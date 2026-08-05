import { useState, useEffect, useRef } from "react";
import { Files, Pin, ExternalLink, RefreshCw, FolderDown, Eye, EyeOff } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { connectionQueryKeys, useReadFile, useReadFileBinary } from "@/services/connection.service";
import { binaryMimeForExtension } from "@/components/execution/activity/fileTypeUtils";
import { LazyFileTree } from "./LazyFileTree";
import type { ConnectionKey } from "@/types/bindings";
import { WorkspaceFileContent } from "./WorkspaceFileContent";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { openFileWithConnection, downloadFileToFolder, opensViaHostCopy } from "@/lib/file-opener";
import { isAbsolutePath } from "@/lib/path-utils";
import { TransferIcon } from "./TransferIcon";
import { transferTooltip, useFileTransfer } from "./useFileTransfer";

interface WorkspaceFilesPanelProps {
  /**
   * Root the tree is browsed from and relative selections resolve against — the
   * session's own working directory, which for an isolated task is the worktree
   * rather than the project root.
   */
  workspacePath: string;
  connection: ConnectionKey;
  wslDistroName?: string;
  isActive?: boolean;
  initialPath?: string;
}

export function WorkspaceFilesPanel({
  workspacePath,
  connection,
  wslDistroName,
  isActive = true,
  initialPath,
}: WorkspaceFilesPanelProps) {
  const [selected, setSelected] = useState<string | null>(initialPath ?? null);
  const [listOpen, setListOpen] = useState(!initialPath);
  const [listPinned, setListPinned] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const openTransfer = useFileTransfer();
  const downloadTransfer = useFileTransfer();
  const [pinnedInitialSize, setPinnedInitialSize] = useState(224);
  const treeRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  // A file link in the stream can point outside the project — an agent reads
  // config from a home directory, a log from /tmp — and `handleOpenFile` hands
  // those over absolute because there is no root to make them relative to.
  // Joining one onto `workspacePath` anyway produced `C:/project/C:/Users/…`,
  // which the read rejects (os error 123) and the OS opener cannot find.
  const fullPath = selected
    ? isAbsolutePath(selected)
      ? selected
      : `${workspacePath}/${selected}`
    : null;
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
    if (!fullPath) return;
    const transferId = `open-${Date.now()}`;
    await openTransfer.run({
      transferId,
      reportsProgress: connection.type === "ssh",
      action: () =>
        openFileWithConnection(connection, fullPath, {
          sshConnectionId: connection.type === "ssh" ? connection.id : undefined,
          transferId,
          wslDistroName,
        }),
      // The file opening is its own confirmation, so success stays quiet here.
    });
  }

  async function handleDownload() {
    if (!fullPath || connection.type === "local") return;
    const transferId = `dl-${Date.now()}`;
    await downloadTransfer.run({
      transferId,
      reportsProgress: connection.type === "ssh",
      action: () => downloadFileToFolder(connection, fullPath, transferId),
      describeDone: (dest) => (dest === null ? null : `Saved to ${dest}`),
    });
  }

  const hiddenButton = (
    <Tooltip>
      <TooltipTrigger
        type="button"
        onClick={() => setShowHidden((v) => !v)}
        className={cn(
          "p-1.5 rounded-md transition-colors shrink-0",
          showHidden
            ? "text-foreground bg-muted/60"
            : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
        )}
      >
        {showHidden ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
      </TooltipTrigger>
      <TooltipContent>{showHidden ? "Hide hidden files" : "Show hidden files"}</TooltipContent>
    </Tooltip>
  );

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
      {hiddenButton}
      {pinButton}
      {refreshButton}
    </>
  );

  const lazyTree = (
    <LazyFileTree
      root={workspacePath}
      connection={connection}
      selectedFile={selected}
      onSelectFile={setSelected}
      expandedFolders={expandedFolders}
      onExpandedFoldersChange={setExpandedFolders}
      showHidden={showHidden}
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

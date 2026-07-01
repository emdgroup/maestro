import { useState } from "react";
import { Files, Pin, Loader2 } from "lucide-react";
import { cn } from "@/lib/ui-utils";
import { FileSelector } from "@/components/execution/diff/FileSelector";
import { useListWorkspaceFiles, useReadFile } from "@/services/connection.service";
import type { ConnectionKey } from "@/types/bindings";
import { WorkspaceFileContent } from "./WorkspaceFileContent";

interface WorkspaceFilesPanelProps {
  projectPath: string;
  connection: ConnectionKey;
}

export function WorkspaceFilesPanel({ projectPath, connection }: WorkspaceFilesPanelProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [listPinned, setListPinned] = useState(false);

  const { data: allFiles = [], isLoading } = useListWorkspaceFiles(connection, projectPath);
  const fullPath = selected ? `${projectPath}/${selected}` : null;
  const {
    data: content,
    isLoading: contentLoading,
    error: contentError,
  } = useReadFile(connection, fullPath);

  if (connection.type === "wsl") {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center">
        <p className="text-xs text-muted-foreground">
          File browser is not supported for WSL connections.
        </p>
      </div>
    );
  }

  const basename = selected ? (selected.split("/").pop() ?? selected) : null;
  const showList = listOpen || listPinned;

  function toggleList() {
    if (listPinned) {
      setListPinned(false);
      setListOpen(false);
    } else {
      setListOpen((v) => !v);
    }
  }

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
        <div className="w-px h-4 bg-border shrink-0 mx-1" />
        <button
          type="button"
          onClick={() => {
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
          <Pin className="w-4 h-4" />
        </button>
      </div>

      {/* Body */}
      <div className="flex flex-1 min-h-0 relative">
        {/* Pinned: side panel */}
        {listPinned && (
          <div className="w-56 shrink-0 border-r border-border flex flex-col min-h-0">
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
                className="flex-1 min-h-0"
              />
            )}
          </div>
        )}

        {/* Overlay: shown when open but not pinned */}
        {listOpen && !listPinned && (
          <>
            <div className="absolute inset-y-0 left-0 z-10 w-56 bg-background border-r border-border flex flex-col min-h-0">
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
                  className="flex-1 min-h-0"
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
    </div>
  );
}

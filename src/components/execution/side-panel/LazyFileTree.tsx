import { useState } from "react";
import { Loader2, ChevronRight, X, Folder, FolderOpen, File } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { useListDirContents, useListWorkspaceFiles } from "@/services/connection.service";
import type { ConnectionKey } from "@/types/bindings";

interface LazyFileTreeProps {
  root: string;
  connection: ConnectionKey;
  wslDistroName?: string;
  selectedFile: string | null;
  onSelectFile: (relativePath: string) => void;
  expandedFolders: Set<string>;
  onExpandedFoldersChange: (folders: Set<string>) => void;
  headerRight?: React.ReactNode;
  className?: string;
}

export function LazyFileTree({
  root,
  connection,
  wslDistroName,
  selectedFile,
  onSelectFile,
  expandedFolders,
  onExpandedFoldersChange,
  headerRight,
  className,
}: LazyFileTreeProps) {
  const [filter, setFilter] = useState("");
  const normalizedFilter = filter.trim().toLowerCase();
  const { data: allFiles } = useListWorkspaceFiles(connection, root);

  return (
    <div className={cn("flex flex-col min-h-0", className)}>
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border shrink-0">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter files..."
          className="flex-1 min-w-0 text-xs bg-transparent outline-none text-foreground placeholder:text-muted-foreground"
        />
        {filter && (
          <Tooltip>
            <TooltipTrigger
              type="button"
              onClick={() => setFilter("")}
              className="shrink-0 p-0.5 text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="w-3 h-3" />
            </TooltipTrigger>
            <TooltipContent>Clear filter</TooltipContent>
          </Tooltip>
        )}
        {headerRight}
      </div>
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {normalizedFilter ? (
          (allFiles ?? [])
            .filter((p) => p.toLowerCase().includes(normalizedFilter))
            .map((relativePath) => {
              const name = relativePath.split("/").pop() ?? relativePath;
              const isSelected = relativePath === selectedFile;
              return (
                <Tooltip key={relativePath}>
                  <TooltipTrigger
                    type="button"
                    onClick={() => onSelectFile(relativePath)}
                    className={cn(
                      "w-full flex items-center py-1 text-left border-l-2 transition-colors gap-1",
                      isSelected
                        ? "border-ring selected-file-item text-foreground"
                        : "border-transparent text-foreground/80 file-tree-item hover:text-foreground",
                    )}
                    style={{ paddingLeft: "20px" }}
                  >
                    <File className="w-3 h-3 shrink-0" />
                    <span className="text-xs truncate">{name}</span>
                  </TooltipTrigger>
                  <TooltipContent>{relativePath}</TooltipContent>
                </Tooltip>
              );
            })
        ) : (
          <DirContents
            absolutePath={root}
            relativePrefix=""
            depth={0}
            connection={connection}
            wslDistroName={wslDistroName}
            expandedFolders={expandedFolders}
            onExpandedFoldersChange={onExpandedFoldersChange}
            selectedFile={selectedFile}
            onSelectFile={onSelectFile}
          />
        )}
      </div>
    </div>
  );
}

interface DirContentsProps {
  absolutePath: string;
  relativePrefix: string;
  depth: number;
  connection: ConnectionKey;
  wslDistroName?: string;
  expandedFolders: Set<string>;
  onExpandedFoldersChange: (folders: Set<string>) => void;
  selectedFile: string | null;
  onSelectFile: (relativePath: string) => void;
}

function DirContents({
  absolutePath,
  relativePrefix,
  depth,
  connection,
  wslDistroName,
  expandedFolders,
  onExpandedFoldersChange,
  selectedFile,
  onSelectFile,
}: DirContentsProps) {
  const { data: entries, isLoading } = useListDirContents(connection, absolutePath, wslDistroName);
  const indent = depth * 12;

  if (isLoading) {
    return (
      <div className="flex items-center py-1" style={{ paddingLeft: `${indent + 8}px` }}>
        <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!entries?.length) return null;

  return (
    <>
      {entries.map((entry) => {
        const childAbsolute = `${absolutePath}/${entry.name}`;
        const childRelative = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;

        if (entry.is_dir) {
          const isExpanded = expandedFolders.has(childAbsolute);
          return (
            <div key={entry.name}>
              <button
                type="button"
                onClick={() => {
                  const next = new Set(expandedFolders);
                  if (isExpanded) next.delete(childAbsolute);
                  else next.add(childAbsolute);
                  onExpandedFoldersChange(next);
                }}
                className="w-full flex items-center gap-1 py-1 text-left text-muted-foreground hover:text-foreground file-tree-item transition-colors"
                style={{ paddingLeft: `${indent + 8}px` }}
              >
                <ChevronRight
                  className={cn("w-3 h-3 shrink-0 transition-transform", isExpanded && "rotate-90")}
                />
                {isExpanded ? (
                  <FolderOpen className="w-3 h-3 shrink-0" />
                ) : (
                  <Folder className="w-3 h-3 shrink-0" />
                )}
                <span className="text-xs truncate">{entry.name}</span>
              </button>
              {isExpanded && (
                <DirContents
                  absolutePath={childAbsolute}
                  relativePrefix={childRelative}
                  depth={depth + 1}
                  connection={connection}
                  wslDistroName={wslDistroName}
                  expandedFolders={expandedFolders}
                  onExpandedFoldersChange={onExpandedFoldersChange}
                  selectedFile={selectedFile}
                  onSelectFile={onSelectFile}
                />
              )}
            </div>
          );
        }

        const isSelected = childRelative === selectedFile;
        return (
          <button
            key={entry.name}
            type="button"
            onClick={() => onSelectFile(childRelative)}
            className={cn(
              "w-full flex items-center py-1 text-left border-l-2 transition-colors gap-1",
              isSelected
                ? "border-ring selected-file-item text-foreground"
                : "border-transparent text-foreground/80 file-tree-item hover:text-foreground",
            )}
            style={{ paddingLeft: `${indent + 20}px` }}
          >
            <File className="w-3 h-3 shrink-0" />
            <span className="text-xs truncate">{entry.name}</span>
          </button>
        );
      })}
    </>
  );
}

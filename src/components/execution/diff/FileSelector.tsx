import { useState } from "react";
import { List, FolderTree, CheckCheck } from "lucide-react";
import { cn } from "@/lib/ui-utils";
import { FileTree } from "./FileTree";

interface FileSelectorFile {
  fileName: string;
  status?: "A" | "M" | "D";
}

interface FileSelectorProps {
  files: FileSelectorFile[];
  selectedFile: string | null;
  onSelectFile: (fileName: string) => void;
  viewedFiles?: Set<string>;
  treeOnly?: boolean;
  treeDefaultExpanded?: boolean;
  headerRight?: React.ReactNode;
  className?: string;
}

export function FileSelector({
  files,
  selectedFile,
  onSelectFile,
  viewedFiles,
  treeOnly = false,
  treeDefaultExpanded,
  headerRight,
  className,
}: FileSelectorProps) {
  const [search, setSearch] = useState("");
  const [fileListMode, setFileListMode] = useState<"flat" | "tree">("flat");

  const mode = treeOnly ? "tree" : fileListMode;

  const filteredFiles = search.trim()
    ? files.filter((f) => f.fileName.toLowerCase().includes(search.toLowerCase()))
    : files;

  const treeFiles = filteredFiles.map((f) => ({
    fileName: f.fileName,
    hunks: [] as [],
    status: f.status,
  }));

  return (
    <div className={cn("flex flex-col min-h-0", className)}>
      {/* Search + mode toggle */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border shrink-0">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter files..."
          className="flex-1 min-w-0 text-xs bg-transparent outline-none text-foreground placeholder:text-muted-foreground"
        />
        {!treeOnly && (
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              type="button"
              onClick={() => setFileListMode("flat")}
              className={cn(
                "p-1.5 rounded text-xs transition-colors",
                mode === "flat"
                  ? "text-foreground bg-muted"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
              )}
              title="Flat list"
            >
              <List className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setFileListMode("tree")}
              className={cn(
                "p-1.5 rounded text-xs transition-colors",
                mode === "tree"
                  ? "text-foreground bg-muted"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
              )}
              title="Tree view"
            >
              <FolderTree className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        {headerRight}
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {mode === "tree" ? (
          <FileTree
            files={treeFiles}
            selectedFile={selectedFile}
            onSelectFile={onSelectFile}
            viewedFiles={viewedFiles}
            defaultExpanded={treeDefaultExpanded}
          />
        ) : (
          filteredFiles.map((file) => {
            const basename = file.fileName.split("/").pop() ?? file.fileName;
            const status = file.status ?? "M";
            const statusColor =
              status === "A" ? "bg-success" : status === "D" ? "bg-destructive" : "bg-warning";
            const isSelected = file.fileName === selectedFile;
            const isViewed = viewedFiles?.has(file.fileName);
            return (
              <button
                key={file.fileName}
                type="button"
                onClick={() => onSelectFile(file.fileName)}
                className={cn(
                  "w-full flex items-center gap-2 px-2 py-2 text-left border-l-2 transition-colors",
                  isSelected
                    ? "border-ring selected-file-item"
                    : "border-transparent hover:bg-muted/10",
                )}
              >
                <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", statusColor)} />
                <span className="flex-1 text-xs truncate text-foreground/80">{basename}</span>
                {isViewed && <CheckCheck className="size-3.5 shrink-0 text-success" />}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

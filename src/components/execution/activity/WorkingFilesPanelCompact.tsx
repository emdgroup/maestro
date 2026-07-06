import { useState } from "react";
import type { ReactNode, RefObject } from "react";
import { ListCollapse, ChevronLeft, ChevronRight, List, FolderTree, FileCode } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { FileTree } from "@/components/execution/diff/FileTree";
import { Slider } from "@/ui/slider";
import type { FileViewType } from "./fileViewUtils";

interface WorkingFilesPanelCompactProps {
  panelRef: RefObject<HTMLDivElement | null>;
  files: string[];
  selectedFile: string | null;
  setSelectedFile: (file: string | null) => void;
  contentArea: ReactNode;
  content: string | null;
  viewType: FileViewType | null;
  zoom: number;
  setZoom: (z: number) => void;
}

export function WorkingFilesPanelCompact({
  panelRef,
  files,
  selectedFile,
  setSelectedFile,
  contentArea,
  content,
  viewType,
  zoom,
  setZoom,
}: WorkingFilesPanelCompactProps) {
  const [listOpen, setListOpen] = useState(false);
  const [fileListMode, setFileListMode] = useState<"flat" | "tree">("flat");
  const [listSearch, setListSearch] = useState("");

  const fileIndex = selectedFile ? files.indexOf(selectedFile) : -1;
  const filteredFiles = listSearch
    ? files.filter((f) => f.toLowerCase().includes(listSearch.toLowerCase()))
    : files;
  const treeFiles = filteredFiles.map((f) => ({ fileName: f, hunks: [], status: "A" as const }));
  const basename = selectedFile ? (selectedFile.split("/").pop() ?? selectedFile) : null;

  return (
    <div ref={panelRef} className="absolute inset-0 flex flex-col bg-background">
      {/* Header: [LayoutList] | [‹] [basename] [›] | [zoom slider] [zoom%] */}
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
          <ListCollapse className="w-4 h-4" />
        </button>
        <div className="w-px h-4 bg-border shrink-0 mx-1" />
        <div className="flex-1 flex items-center justify-center gap-0.5 min-w-0 overflow-hidden">
          <button
            type="button"
            onClick={() => {
              if (fileIndex > 0) setSelectedFile(files[fileIndex - 1]);
            }}
            disabled={fileIndex <= 0}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors disabled:opacity-30 disabled:pointer-events-none shrink-0"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          <span className="text-xs font-mono text-muted-foreground truncate max-w-[14rem]">
            {basename ?? "No file"}
          </span>
          <button
            type="button"
            onClick={() => {
              if (fileIndex < files.length - 1) setSelectedFile(files[fileIndex + 1]);
            }}
            disabled={fileIndex < 0 || fileIndex >= files.length - 1}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors disabled:opacity-30 disabled:pointer-events-none shrink-0"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
        {content !== null && viewType !== null && (
          <>
            <div className="w-px h-4 bg-border shrink-0 mx-1" />
            <Slider
              min={50}
              max={200}
              value={[zoom]}
              onValueChange={(val) => setZoom(Array.isArray(val) ? val[0] : (val as number))}
              className="zoom-slider w-16 shrink-0"
            />
            <button
              type="button"
              onClick={() => setZoom(100)}
              className="px-1 py-0.5 rounded text-[10px] font-mono text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors min-w-10 text-center shrink-0"
            >
              {zoom}%
            </button>
          </>
        )}
      </div>
      {/* File-picker overlay */}
      {listOpen && (
        <div className="absolute top-10 left-0 right-0 bottom-0 z-20 flex flex-col bg-background border-b border-border">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
            <input
              autoFocus
              value={listSearch}
              onChange={(e) => setListSearch(e.target.value)}
              placeholder="Filter files..."
              className="flex-1 min-w-0 text-xs bg-transparent outline-none text-foreground placeholder:text-muted-foreground"
            />
            <div className="flex items-center gap-0.5 shrink-0">
              <button
                type="button"
                onClick={() => setFileListMode("flat")}
                className={cn(
                  "p-1.5 rounded text-xs transition-colors",
                  fileListMode === "flat"
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
                  fileListMode === "tree"
                    ? "text-foreground bg-muted"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
                )}
                title="Tree view"
              >
                <FolderTree className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto custom-scrollbar">
            {fileListMode === "flat" ? (
              filteredFiles.map((file) => {
                const name = file.split("/").pop() ?? file;
                return (
                  <button
                    key={file}
                    type="button"
                    onClick={() => {
                      setSelectedFile(file);
                      setListOpen(false);
                    }}
                    className={cn(
                      "flex items-center gap-2 w-full px-3 py-2 text-left transition-colors text-xs",
                      file === selectedFile
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                    )}
                  >
                    <FileCode className="w-3.5 h-3.5 shrink-0 opacity-60" />
                    <span className="truncate">{name}</span>
                  </button>
                );
              })
            ) : (
              <FileTree
                files={treeFiles}
                selectedFile={selectedFile}
                onSelectFile={(fileName) => {
                  setSelectedFile(fileName);
                  setListOpen(false);
                }}
              />
            )}
          </div>
        </div>
      )}
      {contentArea}
    </div>
  );
}

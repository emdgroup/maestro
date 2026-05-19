import { DiffModeEnum } from "@git-diff-view/react";
import {
  X,
  AlignJustify,
  Columns2,
  List,
  FolderTree,
  RotateCcw,
  Archive,
} from "lucide-react";
import { cn } from "@/lib/ui-utils";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/ui/alert-dialog";
import { Popover, PopoverTrigger, PopoverContent } from "@/ui/popover";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/ui/select";

interface DiffActionBarProps {
  branchName: string;
  viewMode: "uncommitted" | "untracked";
  onViewModeChange: (mode: "uncommitted" | "untracked") => void;
  fileSearch: string;
  onFileSearchChange: (value: string) => void;
  fileListMode: "flat" | "tree";
  onFileListModeChange: (mode: "flat" | "tree") => void;
  diffViewMode: DiffModeEnum;
  onDiffViewModeChange: (mode: DiffModeEnum) => void;
  forceUnified: boolean;
  hasAnyStaged: boolean;
  isDiscarding: boolean;
  isDeletingUntracked: boolean;
  isShelving: boolean;
  shelvePopoverOpen: boolean;
  onShelvePopoverOpenChange: (open: boolean) => void;
  shelveName: string;
  onShelveNameChange: (name: string) => void;
  onRevert: () => void;
  onShelve: () => void;
  onClose: () => void;
}

export function DiffActionBar({
  branchName,
  viewMode,
  onViewModeChange,
  fileSearch,
  onFileSearchChange,
  fileListMode,
  onFileListModeChange,
  diffViewMode,
  onDiffViewModeChange,
  forceUnified,
  hasAnyStaged,
  isDiscarding,
  isDeletingUntracked,
  isShelving,
  shelvePopoverOpen,
  onShelvePopoverOpenChange,
  shelveName,
  onShelveNameChange,
  onRevert,
  onShelve,
  onClose,
}: DiffActionBarProps) {
  const splitActive =
    !forceUnified &&
    viewMode !== "untracked" &&
    diffViewMode === DiffModeEnum.SplitGitHub;

  const revertDisabled =
    viewMode === "untracked"
      ? !hasAnyStaged || isDeletingUntracked
      : !hasAnyStaged || isDiscarding;

  return (
    <div className="relative h-12 border-b border-border bg-muted/30 flex items-center px-4 shrink-0">
      {/* Left side: file search + flat/tree toggle */}
      <div className="flex items-center gap-2 z-10">
        <Input
          placeholder="Filter files..."
          value={fileSearch}
          onChange={(e) => onFileSearchChange(e.target.value)}
          className="h-8 w-48 text-xs"
        />
        <ToggleGroup
          value={[fileListMode]}
          onValueChange={(values) => {
            if (values.includes("tree")) onFileListModeChange("tree");
            else onFileListModeChange("flat");
          }}
        >
          <ToggleGroupItem value="flat" size="sm" variant="outline" className="size-8 p-0">
            <List className="size-3.5" />
          </ToggleGroupItem>
          <ToggleGroupItem value="tree" size="sm" variant="outline" className="size-8 p-0">
            <FolderTree className="size-3.5" />
          </ToggleGroupItem>
        </ToggleGroup>

        {/* Revert button with confirmation dialog */}
        <AlertDialog>
          <AlertDialogTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                disabled={revertDisabled}
                className="h-8 w-8 p-0"
                title={
                  viewMode === "untracked" ? "Delete selected files" : "Revert selected changes"
                }
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            }
          />
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {viewMode === "untracked" ? "Delete files?" : "Discard changes?"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {viewMode === "untracked"
                  ? "This will permanently delete the selected untracked files. This action cannot be undone."
                  : "This will permanently discard the selected changes. This action cannot be undone."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={onRevert}>
                {viewMode === "untracked" ? "Delete" : "Discard"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Shelve button with name popover */}
        <Popover open={shelvePopoverOpen} onOpenChange={onShelvePopoverOpenChange}>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                disabled={!hasAnyStaged || isShelving || viewMode === "untracked"}
                className="h-8 w-8 p-0"
                title="Shelve selected changes"
              >
                <Archive className="h-3.5 w-3.5" />
              </Button>
            }
          />
          <PopoverContent className="w-64 p-3">
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium">Stash name</label>
              <Input
                value={shelveName}
                onChange={(e) => onShelveNameChange(e.target.value)}
                className="h-8 text-xs"
                placeholder="wip-branch-name-2026-04-02"
              />
              <Button
                size="sm"
                className="w-full"
                disabled={!shelveName.trim() || isShelving}
                onClick={onShelve}
              >
                {isShelving ? "Shelving..." : "Confirm"}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {/* Center: view mode dropdown */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="pointer-events-auto flex items-center gap-1.5 font-mono text-sm font-semibold">
          <span className="truncate max-w-48">{branchName}</span>
          <span>-</span>
          <Select
            value={viewMode}
            onValueChange={(v) => onViewModeChange(v as "uncommitted" | "untracked")}
          >
            <SelectTrigger
              size="sm"
              className="h-auto border-none shadow-none bg-transparent font-mono text-sm font-semibold p-0 gap-1 focus:ring-0"
            >
              <SelectValue>
                {viewMode === "uncommitted" ? "Uncommitted Changes" : "Untracked Changes"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="uncommitted">Uncommitted Changes</SelectItem>
              <SelectItem value="untracked">Untracked Changes</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Right side: unified/split toggle + close button */}
      <div className="ml-auto flex items-center gap-2 z-10">
        <ToggleGroup
          value={[splitActive ? "split" : "unified"]}
          onValueChange={(values) => {
            if (forceUnified || viewMode === "untracked") return;
            if (values.includes("split")) {
              onDiffViewModeChange(DiffModeEnum.SplitGitHub);
            } else {
              onDiffViewModeChange(DiffModeEnum.Unified);
            }
          }}
        >
          <ToggleGroupItem value="unified" size="sm" variant="outline" className="size-8 p-0">
            <AlignJustify className="size-3.5" />
          </ToggleGroupItem>
          <ToggleGroupItem
            value="split"
            size="sm"
            variant="outline"
            disabled={forceUnified || viewMode === "untracked"}
            className={cn(
              "size-8 p-0",
              (forceUnified || viewMode === "untracked") && "opacity-30 cursor-not-allowed",
            )}
          >
            <Columns2 className="size-3.5" />
          </ToggleGroupItem>
        </ToggleGroup>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
}

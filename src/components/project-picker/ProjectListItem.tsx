import { Button } from "@/ui/button";
import { X } from "lucide-react";
import { getFolderName } from "@/lib";
import React from "react";

interface ProjectListItemProps {
  path: string;
  onClick: () => void;
  onRemove?: () => void;
  disabled?: boolean;
}

/**
 * Shared project list item component for both local and remote project lists.
 * Displays project folder name and full path with an optional remove button.
 * Keyboard navigation: Del key removes project, Tab skips remove button.
 */
export function ProjectListItem({
  path,
  onClick,
  onRemove,
  disabled = false,
}: ProjectListItemProps) {
  function handleKeyDown(e: React.KeyboardEvent) {
    // Del key removes the project
    if (e.key === "Delete" && onRemove && !disabled) {
      e.preventDefault();
      onRemove();
    }
  }

  return (
    <li className="relative group">
      <Button
        onClick={onClick}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        variant="outline"
        className="w-full text-left justify-start font-mono text-sm h-auto py-3 px-4 pr-12 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 hover:bg-background"
      >
        <div className="flex flex-col items-start gap-1 w-full">
          <span className="font-semibold">{getFolderName(path)}</span>
          <span className="text-xs text-muted-foreground truncate w-full">{path}</span>
        </div>
      </Button>
      {onRemove && (
        <Button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          variant={"ghost"}
          tabIndex={-1}
          className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-md hover:bg-destructive/10 hover:text-destructive opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
          title="Remove from recent projects (Del key)"
          aria-label="Remove from recent projects"
        >
          <X className="size-3.5" />
        </Button>
      )}
    </li>
  );
}

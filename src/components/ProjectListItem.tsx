import { Button } from "./ui/button";
import { X } from "lucide-react";
import { getFolderName } from "../lib/path-utils";

interface ProjectListItemProps {
  path: string;
  onClick: () => void;
  onRemove?: () => void;
  disabled?: boolean;
}

/**
 * Shared project list item component for both local and remote project lists.
 * Displays project folder name and full path with an optional remove button.
 */
export function ProjectListItem({
  path,
  onClick,
  onRemove,
  disabled = false,
}: ProjectListItemProps) {
  return (
    <li className="relative group">
      <Button
        onClick={onClick}
        disabled={disabled}
        variant="outline"
        className="w-full text-left justify-start font-mono text-sm h-auto py-3 px-4 pr-12"
      >
        <div className="flex flex-col items-start gap-1 w-full">
          <span className="font-semibold">{getFolderName(path)}</span>
          <span className="text-xs text-muted-foreground truncate w-full">
            {path}
          </span>
        </div>
      </Button>
      {onRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-md hover:bg-destructive/10 hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
          title="Remove from recent projects"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </li>
  );
}

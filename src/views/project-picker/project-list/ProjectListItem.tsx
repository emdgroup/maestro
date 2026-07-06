import { Button } from "@/ui/button";
import { Lock, X } from "lucide-react";
import { getFolderName } from "@/lib/path-utils";
import { cn } from "@/lib/utils.ts";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/ui/tooltip";
import React from "react";

interface ProjectListItemProps {
  path: string;
  onClick: () => void;
  onRemove?: () => void;
  disabled?: boolean;
  locked?: boolean;
}

export function ProjectListItem({
  path,
  onClick,
  onRemove,
  disabled = false,
  locked = false,
}: ProjectListItemProps) {
  const isDisabled = disabled || locked;

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Delete" && onRemove && !isDisabled) {
      e.preventDefault();
      onRemove();
    }
  }

  const button = (
    <Button
      onClick={onClick}
      onKeyDown={handleKeyDown}
      disabled={isDisabled}
      variant="outline"
      className={cn(
        "w-full text-left justify-start font-mono text-sm h-auto py-3 px-4 pr-12 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 hover:bg-background hover:border-accent hover:text-accent shadow-md",
        locked && "opacity-50 cursor-not-allowed",
      )}
    >
      <div className="flex flex-col items-start gap-1 w-full">
        <span className="font-semibold flex items-center gap-1.5">
          {locked && <Lock className="size-3.5 text-muted-foreground shrink-0" />}
          {getFolderName(path)}
        </span>
        <span className="text-xs text-muted-foreground truncate w-full">{path}</span>
      </div>
    </Button>
  );

  return (
    <li className="relative group">
      {locked ? (
        <TooltipProvider delay={300}>
          <Tooltip>
            <TooltipTrigger render={<div className="w-full">{button}</div>} />
            <TooltipContent side="top">Project already open in another instance</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        button
      )}
      {onRemove && !locked && (
        <Button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          variant="ghost"
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

import { cn } from "@/lib/utils.ts";
import { MessageSquare, CheckCheck } from "lucide-react";
import { Button } from "@/ui/button";
import type { DiffFileWithName } from "@/types/review";

interface ReviewFileHeaderProps {
  selectedFile: DiffFileWithName;
  viewedFiles: Set<string>;
  onToggleViewed: (fileName: string) => void;
  onFileComment: (fileName: string) => void;
}

export function ReviewFileHeader({
  selectedFile,
  viewedFiles,
  onToggleViewed,
  onFileComment,
}: ReviewFileHeaderProps) {
  const stats = selectedFile.hunks.reduce(
    (acc, h) => {
      for (const line of h.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) acc.insertions++;
        if (line.startsWith("-") && !line.startsWith("---")) acc.deletions++;
      }
      return acc;
    },
    { insertions: 0, deletions: 0 },
  );
  const status = selectedFile.status ?? "M";
  const statusColor =
    status === "A"
      ? "text-success"
      : status === "D"
        ? "text-destructive"
        : "text-muted-foreground";
  const isViewed = viewedFiles.has(selectedFile.fileName);
  return (
    <div className="px-3 py-1.5 border-b border-border bg-muted/20 shrink-0 flex items-center gap-2 text-xs">
      <span className="font-mono text-foreground truncate flex-1">
        {selectedFile.fileName}
      </span>
      <span className={cn("font-medium shrink-0", statusColor)}>{status}</span>
      {stats.insertions > 0 && (
        <span className="text-success shrink-0">+{stats.insertions}</span>
      )}
      {stats.deletions > 0 && (
        <span className="text-destructive shrink-0">-{stats.deletions}</span>
      )}
      <Button
        variant="ghost"
        onClick={() => onFileComment(selectedFile.fileName)}
        className="flex items-center gap-1 px-1.5 py-0.5 h-auto rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted/30"
        title="Add file comment"
      >
        <MessageSquare className="size-3" />
      </Button>
      <Button
        variant="ghost"
        onClick={() => onToggleViewed(selectedFile.fileName)}
        className={cn(
          "flex items-center gap-1 px-1.5 py-0.5 h-auto rounded border border-border hover:bg-muted/30",
          isViewed ? "text-success" : "text-muted-foreground hover:text-foreground",
        )}
        title={isViewed ? "Mark as unviewed" : "Mark as viewed"}
      >
        <CheckCheck className="size-3" />
        <span className="text-[10px]">Viewed</span>
      </Button>
    </div>
  );
}

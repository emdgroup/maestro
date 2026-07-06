import { FileText, FileDiff } from "lucide-react";
import { cn } from "@/lib/utils.ts";

interface ActivityFileCardProps {
  variant: "working-files" | "review-changes";
  fileNames: string[];
  onClick: () => void;
}

export function ActivityFileCard({ variant, fileNames, onClick }: ActivityFileCardProps) {
  const isWorkingFiles = variant === "working-files";
  const count = fileNames.length;
  const Icon = isWorkingFiles ? FileText : FileDiff;

  const title = isWorkingFiles ? "Working Files Updated" : "Files Changed";
  const subtitle = isWorkingFiles
    ? `${count} working file${count !== 1 ? "s" : ""} updated`
    : `${count} file${count !== 1 ? "s" : ""} modified in this session`;

  const basenames = fileNames.map((f) => f.split("/").pop() ?? f);

  return (
    <div
      className={cn(
        "group rounded-[10px] overflow-hidden",
        "border border-accent/30 bg-gradient-to-br from-accent/10 to-transparent",
        "shadow-[0_2px_8px_oklch(0%_0_0/0.08)]",
        "hover:border-accent/50 hover:from-accent/15 transition-colors",
      )}
    >
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        <div className="w-7 h-7 rounded-[7px] flex items-center justify-center shrink-0 bg-accent/10 border border-accent/30">
          <Icon className="w-3.5 h-3.5 text-accent" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-foreground/85">{title}</div>
          <div className="text-[10px] text-muted-foreground mt-0.5">{subtitle}</div>
        </div>
        <button
          type="button"
          onClick={onClick}
          className="text-[11px] font-medium px-2.5 py-1 rounded-md bg-accent text-accent-foreground shrink-0 opacity-40 group-hover:opacity-100 hover:opacity-100 transition-opacity cursor-pointer"
        >
          Open
        </button>
      </div>
      {basenames.length > 0 && (
        <div className="flex gap-1 flex-wrap px-3.5 pb-2.5">
          {basenames.map((name) => (
            <span
              key={name}
              className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono truncate max-w-[160px]"
            >
              {name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

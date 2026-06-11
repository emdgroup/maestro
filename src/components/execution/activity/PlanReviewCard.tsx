import { Route, ChevronRight } from "lucide-react";
import { cn } from "@/lib/ui-utils";
import type { ToolCallItem } from "./types";

interface PlanReviewCardProps {
  item: ToolCallItem;
  isPending: boolean;
  responseStatus: "accepted" | "rejected" | null;
  onOpen: () => void;
}

export function PlanReviewCard({ item, isPending, responseStatus, onOpen }: PlanReviewCardProps) {
  const resolved = responseStatus !== null;
  const clickable = isPending && !resolved;

  return (
    <div
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? onOpen : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") onOpen();
            }
          : undefined
      }
      className={cn(
        "rounded-[10px] overflow-hidden",
        "border border-accent/30 bg-gradient-to-br from-accent/10 to-transparent",
        "shadow-[0_2px_8px_oklch(0%_0_0/0.08)]",
        clickable && "hover:border-accent/50 hover:from-accent/15 transition-colors cursor-pointer",
        resolved && "border-border bg-card/50 shadow-none",
      )}
    >
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        <div
          className={cn(
            "w-7 h-7 rounded-[7px] flex items-center justify-center shrink-0",
            "border",
            resolved
              ? "bg-muted/50 border-border"
              : "bg-accent/10 border-accent/30",
          )}
        >
          <Route
            className={cn(
              "w-3.5 h-3.5",
              resolved ? "text-muted-foreground" : "text-accent",
            )}
          />
        </div>

        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-foreground/85">Plan Ready for Review</div>
          {item.title && (
            <div className="text-[10px] text-muted-foreground mt-0.5 truncate">{item.title}</div>
          )}
        </div>

        <span
          className={cn(
            "text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0",
            isPending && !resolved && "bg-accent/15 text-accent",
            responseStatus === "accepted" && "bg-success/15 text-success",
            responseStatus === "rejected" && "bg-destructive/15 text-destructive",
            !isPending && !resolved && "bg-muted text-muted-foreground",
          )}
        >
          {resolved
            ? responseStatus === "accepted"
              ? "Accepted"
              : "Rejected"
            : isPending
              ? "Pending"
              : ""}
        </span>

        {clickable && (
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
        )}
      </div>
    </div>
  );
}

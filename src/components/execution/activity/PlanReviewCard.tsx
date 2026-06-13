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

  if (clickable) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onOpen();
        }}
        className="group rounded-[10px] overflow-hidden bg-accent shadow-[0_2px_12px_oklch(55%_0.15_250/0.25)] hover:shadow-[0_4px_20px_oklch(55%_0.15_250/0.3)] hover:-translate-y-px transition-all duration-150 cursor-pointer"
      >
        <div className="flex items-center gap-2.5 px-3.5 py-2.5">
          <Route className="w-4 h-4 text-white/80 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold text-white/95">Plan Ready for Review</div>
            {item.title && (
              <div className="text-[10px] text-white/60 mt-0.5 truncate">{item.title}</div>
            )}
          </div>
          <span className="text-[11px] font-semibold text-white/90 bg-white/15 px-2.5 py-1 rounded-md shrink-0">
            Review Plan
          </span>
          <ChevronRight className="w-4 h-4 text-white/50 shrink-0 transition-transform duration-150 group-hover:translate-x-0.5" />
        </div>
      </div>
    );
  }

  // resolved or non-pending — old card style
  return (
    <div
      className={cn(
        "rounded-[10px] overflow-hidden",
        "border border-border bg-card/50 shadow-none",
      )}
    >
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        <div className="w-7 h-7 rounded-[7px] flex items-center justify-center shrink-0 border bg-muted/50 border-border">
          <Route className="w-3.5 h-3.5 text-muted-foreground" />
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
            responseStatus === "accepted" && "bg-success/15 text-success",
            responseStatus === "rejected" && "bg-destructive/15 text-destructive",
            responseStatus === null && "bg-muted text-muted-foreground",
          )}
        >
          {responseStatus === "accepted"
            ? "Accepted"
            : responseStatus === "rejected"
              ? "Rejected"
              : "—"}
        </span>
      </div>
    </div>
  );
}

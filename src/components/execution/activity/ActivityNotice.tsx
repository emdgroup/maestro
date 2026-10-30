import { useState } from "react";
import { format } from "date-fns";
import { ChevronDown, ChevronRight, Info, OctagonX, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NoticeItem } from "./types";

/**
 * Past this the two clamped lines are likely cut, so the row offers to open. A guess at layout,
 * not at meaning: a row that opens onto nothing new costs a click and no more.
 */
const LONG_NOTICE_CHARS = 140;

/**
 * A notice the agent sent this session: a muted line where it arrived, at the weight of a
 * tool-call label. Notices are live events the agent never replays, so the row is gone once the
 * session is reloaded, which is what ACP asks of them.
 */
export function ActivityNotice({ notice }: { notice: NoticeItem }) {
  const [open, setOpen] = useState(false);
  const long = notice.title.length + (notice.description?.length ?? 0) > LONG_NOTICE_CHARS;
  const Icon =
    notice.severity === "warning" ? TriangleAlert : notice.severity === "info" ? Info : OctagonX;
  const toggle = () => setOpen((v) => !v);

  return (
    <div
      role={long ? "button" : undefined}
      tabIndex={long ? 0 : undefined}
      aria-expanded={long ? open : undefined}
      onClick={long ? toggle : undefined}
      onKeyDown={
        long
          ? (e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              toggle();
            }
          : undefined
      }
      className={cn(
        "-ml-1 flex items-start gap-1.5 rounded-md px-1 py-0.5 text-xs text-muted-foreground",
        long && "cursor-pointer transition-colors hover:bg-foreground/7",
      )}
    >
      <Icon
        className={cn(
          "mt-px size-3.5 shrink-0",
          notice.severity === "warning" && "text-warning",
          notice.severity !== "warning" && notice.severity !== "info" && "text-destructive",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-1.5">
          <span
            className={cn(
              "min-w-0",
              !open && "line-clamp-2",
              notice.severity === "warning" && "text-foreground/75",
              notice.severity !== "warning" && notice.severity !== "info" && "text-destructive/90",
            )}
          >
            {notice.title}
          </span>
          {long &&
            (open ? (
              <ChevronDown className="mt-0.5 size-3 shrink-0" />
            ) : (
              <ChevronRight className="mt-0.5 size-3 shrink-0" />
            ))}
          <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-[10px] tabular-nums">
            {notice.count > 1 && (
              <span className="rounded-full border border-border px-1.5">×{notice.count}</span>
            )}
            <span>{format(notice.at, "p")}</span>
          </span>
        </div>
        {notice.description && (
          <div
            className={cn(
              "mt-0.5 text-[11px] leading-snug text-muted-foreground/80",
              !open && "line-clamp-2",
            )}
          >
            {notice.description}
          </div>
        )}
      </div>
    </div>
  );
}

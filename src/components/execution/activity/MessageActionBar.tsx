import { useSyncExternalStore, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { format, formatDistance } from "date-fns";
import { Button } from "@/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { cn } from "@/lib/utils";
import { useCopyToClipboard } from "./HighlightedCode";

export function relativeTime(sentAt: number, now: number): string {
  // date-fns says "less than a minute ago"; under a minute reads better as "just now".
  if (now - sentAt < 60_000) return "just now";
  return formatDistance(sentAt, now, { addSuffix: true });
}

// One timer for the whole stream, not one per message: a long session holds hundreds of
// these and each would otherwise wake the main thread on its own schedule.
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let tick = 0;

function subscribeTick(fn: () => void) {
  listeners.add(fn);
  timer ??= setInterval(() => {
    tick++;
    for (const l of listeners) l();
  }, 30_000);
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

interface MessageActionBarProps {
  copyText: string;
  /** Omitted for messages replayed from history, where the real send time is unknown. */
  sentAt?: number;
  align?: "start" | "end";
  /** Extra actions, rendered next to copy. */
  children?: ReactNode;
}

export function MessageActionBar({
  copyText,
  sentAt,
  align = "start",
  children,
}: MessageActionBarProps) {
  const { copied, copy } = useCopyToClipboard(copyText);
  useSyncExternalStore(subscribeTick, () => tick);

  return (
    <div
      className={cn(
        // Hidden at rest, revealed by hover — or by focus, so the actions stay reachable
        // from the keyboard where there is no pointer to hover with.
        "flex h-7 items-center gap-0.5 text-xs text-muted-foreground/60 opacity-0 transition-opacity",
        "group-hover/message-block:opacity-100 focus-within:opacity-100",
        align === "end" && "flex-row-reverse",
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={copy}
              aria-label={copied ? "Copied" : "Copy message"}
              className="text-muted-foreground/60 hover:text-foreground"
            />
          }
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </TooltipTrigger>
        <TooltipContent>{copied ? "Copied" : "Copy message"}</TooltipContent>
      </Tooltip>
      {children}
      {sentAt !== undefined && (
        <Tooltip>
          <TooltipTrigger
            render={<span />}
            className={cn("cursor-default px-1 tabular-nums", align === "end" && "order-first")}
          >
            {relativeTime(sentAt, Date.now())}
          </TooltipTrigger>
          <TooltipContent>{format(sentAt, "PPpp")}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

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
//
// The store holds the clock rather than a counter, because the label has to be derived from
// what useSyncExternalStore returns. Calling Date.now() in render instead reads the clock
// behind React's back: the notification still fires, but React may bail out of a forced
// store re-render when no tracked value changed, and the label freezes on its first value.
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let now = Date.now();

function subscribeTick(fn: () => void) {
  // The timer only runs while something is subscribed, so `now` can be arbitrarily old by
  // the time a bar mounts. React re-reads the snapshot after subscribing and re-renders if
  // it moved, so refreshing here is enough — no notification needed.
  now = Date.now();
  listeners.add(fn);
  timer ??= setInterval(() => {
    now = Date.now();
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
  const clock = useSyncExternalStore(subscribeTick, () => now);

  return (
    <div
      className={cn(
        // Hidden at rest, revealed by hover — or by focus, so the actions stay reachable
        // from the keyboard where there is no pointer to hover with.
        "flex h-7 items-center gap-0.5 text-xs text-muted-foreground/60 opacity-0 transition-opacity",
        "group-hover/message-block:opacity-100 focus-within:opacity-100",
        align === "end" && "justify-end",
      )}
    >
      {sentAt !== undefined && (
        <Tooltip>
          <TooltipTrigger render={<span />} className="cursor-default px-1 tabular-nums">
            {relativeTime(sentAt, clock)}
          </TooltipTrigger>
          <TooltipContent>{format(sentAt, "PPpp")}</TooltipContent>
        </Tooltip>
      )}
      {children}
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
    </div>
  );
}

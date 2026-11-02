import { useState } from "react";
import { Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";

interface SendStopButtonProps {
  stop: boolean;
  /** Only ever stops Send: a turn can always be interrupted. */
  disabled: boolean;
  onSend: () => void;
  onCancel: () => void;
}

/**
 * The compose bar's main action. One button rather than two, so it can play the change: the plane
 * flies off as the turn starts, and the arc closes into a ring when it ends. The steps are in
 * index.css under `.send-stop`. Nothing plays on mount, so a session opened mid-turn just shows Stop.
 */
export function SendStopButton({ stop, disabled, onSend, onCancel }: SendStopButtonProps) {
  const [shown, setShown] = useState(stop);
  const [play, setPlay] = useState<"start" | "return" | null>(null);
  if (stop !== shown) {
    setShown(stop);
    setPlay(stop ? "start" : "return");
  }

  const label = stop ? "Cancel" : "Send (Enter)";
  return (
    <Tooltip>
      <TooltipTrigger
        render={<button type="button" disabled={!stop && disabled} />}
        aria-label={label}
        data-stop={stop}
        data-play={play ?? undefined}
        onClick={stop ? onCancel : onSend}
        // Every part runs for as long as the button's own animation, and a view hidden and shown
        // again would replay one left set.
        onAnimationEnd={(e) => e.target === e.currentTarget && setPlay(null)}
        className={cn(
          "send-stop relative grid h-8 w-8 shrink-0 place-items-center rounded-full border transition-all duration-150",
          stop
            ? "border-destructive/40 bg-destructive/8 text-destructive opacity-60 hover:bg-destructive/15 hover:opacity-100"
            : "border-accent/25 bg-accent/15 text-accent shadow-[inset_0_1px_0_0_rgba(255,255,255,0.1)] hover:scale-105 hover:border-accent/40 hover:bg-accent/30 active:scale-95 disabled:cursor-not-allowed disabled:opacity-20 disabled:hover:scale-100",
        )}
      >
        <span className="send-stop-whip">
          <svg
            viewBox="0 0 42 42"
            // `busy-arc` is the hook reduce-motion uses to turn this arc into a complete static
            // ring rather than freezing it mid-rotation.
            className="busy-arc send-stop-arc"
          >
            <circle
              cx="20"
              cy="20"
              r="16"
              fill="none"
              stroke="currentColor"
              strokeOpacity={1}
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeDasharray="22 79"
            />
          </svg>
        </span>
        <Send className="send-stop-plane h-4 w-4 translate-x-[-0.5px] translate-y-[0.5px]" />
        <svg className="send-stop-square h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
          <rect x="4" y="4" width="16" height="16" rx="2.5" />
        </svg>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

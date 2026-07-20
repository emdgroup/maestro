import { useState, useRef, useCallback, useEffect } from "react";
import { Dumbbell } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { cn } from "@/lib/utils.ts";
import { TRIGGER_CLASS, GLASS_CONTENT_CLASS } from "./BaseDropdownSelector";
import type { SelectorProps } from "./BaseDropdownSelector";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip.tsx";

const PAD = 11; // shell px padding = thumb radius — keeps thumb inside shell
const INSET = 8; // extra inset so first/last dot sit inside track, not at edge

// Inner track span as a CSS calc fragment (100% = shell width)
const INNER = `(100% - ${2 * PAD + 2 * INSET}px)`;

function calcLeft(frac: number): string {
  return `calc(${PAD + INSET}px + ${frac} * ${INNER})`;
}

function fracFromClientX(shell: HTMLElement, clientX: number): number {
  const r = shell.getBoundingClientRect();
  return Math.max(
    0,
    Math.min(1, (clientX - r.left - PAD - INSET) / (r.width - 2 * PAD - 2 * INSET)),
  );
}

export function EffortSelector({ option, value, onChange, disabled }: SelectorProps) {
  const options = option.options.filter((o) => o.value !== "default");
  const N = options.length;
  const currentIdx = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(currentIdx);
  const [dragFrac, setDragFrac] = useState<number | null>(null);

  const shellRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  // stale-closure guard for global handlers registered once
  const live = useRef({ N, onChange, options });
  live.current = { N, onChange, options };

  useEffect(() => {
    const i = options.findIndex((o) => o.value === value);
    if (i >= 0) setIdx(i);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  // global drag + touch — registered once, reads live ref
  useEffect(() => {
    const move = (clientX: number) => {
      if (!dragging.current || !shellRef.current) return;
      setDragFrac(fracFromClientX(shellRef.current, clientX));
    };
    const up = (clientX: number) => {
      if (!dragging.current || !shellRef.current) return;
      dragging.current = false;
      const { N, onChange, options } = live.current;
      const snapped = Math.round(fracFromClientX(shellRef.current, clientX) * (N - 1));
      setIdx(snapped);
      setDragFrac(null);
      onChange(options[snapped].value);
    };
    const onMouseMove = (e: MouseEvent) => move(e.clientX);
    const onMouseUp = (e: MouseEvent) => up(e.clientX);
    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      move(e.touches[0].clientX);
    };
    const onTouchEnd = (e: TouchEvent) => up(e.changedTouches[0].clientX);

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, []);

  if (N === 0) return null;

  const displayFrac = dragFrac !== null ? dragFrac : idx / (N - 1);
  const displayIdx = dragFrac !== null ? Math.round(dragFrac * (N - 1)) : idx;
  const isSnapping = dragFrac === null;

  const snapClass =
    "transition-[left,width] duration-[220ms] [transition-timing-function:cubic-bezier(0.34,1.56,0.64,1)]";

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (disabled || !shellRef.current) return;
      e.preventDefault();
      dragging.current = true;
      setDragFrac(fracFromClientX(shellRef.current, e.clientX));
    },
    [disabled],
  );

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (disabled || !shellRef.current) return;
      dragging.current = true;
      setDragFrac(fracFromClientX(shellRef.current, e.touches[0].clientX));
    },
    [disabled],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex items-center" />}>
          <PopoverTrigger disabled={disabled} className={TRIGGER_CLASS}>
            <Dumbbell className="size-3 shrink-0" />
            <span>{options[currentIdx]?.name ?? value}</span>
          </PopoverTrigger>
          {option.description && (
            <TooltipContent side="top" sideOffset={6}>
              {option.description}
            </TooltipContent>
          )}
        </TooltipTrigger>
      </Tooltip>

      <PopoverContent
        side="top"
        align="center"
        sideOffset={6}
        className={cn(
          GLASS_CONTENT_CLASS,
          "flex-row items-center px-3 py-2 w-56 gap-0 rounded-full",
        )}
      >
        <span className="text-[10px] font-medium text-muted-foreground shrink-0">
          {options[0].name}
        </span>

        {/* track shell — containing block for CSS calc positions; no overflow:hidden */}
        <div
          ref={shellRef}
          className="relative flex-1 h-8 cursor-pointer select-none focus-visible:outline-none"
          tabIndex={disabled ? -1 : 0}
          onMouseDown={onMouseDown}
          onTouchStart={onTouchStart}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowUp") {
              const next = Math.min(N - 1, idx + 1);
              setIdx(next);
              onChange(options[next].value);
              e.preventDefault();
            } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
              const next = Math.max(0, idx - 1);
              setIdx(next);
              onChange(options[next].value);
              e.preventDefault();
            }
          }}
        >
          {/* track background */}
          <div className="absolute inset-x-2.75 top-1/2 -translate-y-1/2 h-3.5 rounded-full bg-muted" />

          {/* fill — left fixed at PAD, width grows via calc */}
          <div
            className={cn(
              "absolute top-1/2 -translate-y-1/2 h-3.5 rounded-full",
              "bg-gradient-to-r from-accent/50 to-accent",
              isSnapping && snapClass,
            )}
            style={{
              left: PAD,
              width: `calc(${INSET}px + ${displayFrac} * ${INNER})`,
              boxShadow: "0 0 10px color-mix(in srgb, var(--color-accent) 40%, transparent)",
            }}
          />

          {/* stop dots */}
          {options.map((_, i) => (
            <div
              key={i}
              className={cn(
                "absolute size-1.5 rounded-full pointer-events-none z-3",
                i === displayIdx ? "opacity-0" : i < displayIdx ? "bg-white/30" : "bg-white/15",
              )}
              style={{
                left: calcLeft(i / (N - 1)),
                top: "50%",
                transform: "translate(-50%, -50%)",
              }}
            />
          ))}

          {/* thumb */}
          <div
            className={cn(
              "absolute size-5.5 rounded-full bg-white pointer-events-none z-4",
              "shadow-[0_1px_6px_rgba(0,0,0,0.55),0_0_0_1px_rgba(0,0,0,0.10)]",
              isSnapping && snapClass,
            )}
            style={{ left: calcLeft(displayFrac), top: "50%", transform: "translate(-50%, -50%)" }}
          />
        </div>

        <span className="text-[10px] font-medium text-muted-foreground shrink-0">
          {options[N - 1].name}
        </span>
      </PopoverContent>
    </Popover>
  );
}

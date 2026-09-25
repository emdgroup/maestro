import { useRef, useState } from "react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/ui/hover-card";

/** A titled grid of cards, with a count and an optional control beside the title. */
export function CardSection({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        {title}
        {count !== undefined && (
          <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
            {count}
          </span>
        )}
        {action}
      </h3>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3">{children}</div>
    </section>
  );
}

export const CARD =
  "group relative flex flex-col gap-2 rounded-xl border border-border bg-card p-4 transition-colors hover:border-accent/60";

/** A card for something listed but not managed here: Maestro's own, or the project's. */
export function ListedCard({
  icon,
  title,
  badge,
  description,
  footer,
}: {
  icon: React.ReactNode;
  title: string;
  badge?: string;
  description: string;
  footer: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-dashed border-border bg-card p-4">
      <div className="flex items-center gap-2">
        {icon}
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</span>
        {badge && (
          <span className="truncate rounded-md border border-border px-1.5 text-[10px] text-muted-foreground">
            {badge}
          </span>
        )}
      </div>
      <Description text={description} />
      <div className="mt-auto flex flex-wrap items-center gap-1.5">{footer}</div>
    </div>
  );
}

export function EveryAgent() {
  return <span className="text-[11px] text-muted-foreground">Every agent</span>;
}

const CLAMPED = "line-clamp-3 text-xs leading-relaxed text-muted-foreground";

/**
 * A card's description, clamped to three lines, with the whole of it in a popup on hover. The
 * popup only opens when the clamp actually cut something, measured as the pointer arrives, so a
 * card resized since render is judged at its current width.
 */
export function Description({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  if (!text) return <p className={CLAMPED} />;
  return (
    <HoverCard
      open={open}
      onOpenChange={(next) => {
        const p = ref.current;
        setOpen(next && p !== null && p.scrollHeight > p.clientHeight);
      }}
    >
      <HoverCardTrigger delay={400} render={<p ref={ref} className={CLAMPED} />}>
        {text}
      </HoverCardTrigger>
      <HoverCardContent
        side="bottom"
        align="start"
        className="max-h-80 w-96 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed"
      >
        {text}
      </HoverCardContent>
    </HoverCard>
  );
}

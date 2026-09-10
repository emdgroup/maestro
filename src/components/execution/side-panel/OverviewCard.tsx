import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils.ts";

/**
 * One row of the Overview: an icon, a label, a subtitle, an optional badge, and whatever the
 * caller wants under the fold.
 *
 * Shared by the Overview's own cards and by `PullRequestCard`, which is why it lives here rather
 * than in either — importing it from `OverviewPanel` would make the pull request module and the
 * panel import each other.
 */
export function Card({
  available,
  onClick,
  icon,
  iconBg,
  label,
  sub,
  badge,
  badgeClass,
  children,
}: {
  available: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  iconBg: string;
  label: string;
  sub: string;
  /** A node rather than a string so a badge can carry two tones — see the pull request card. */
  badge?: React.ReactNode;
  badgeClass?: string;
  children?: React.ReactNode;
}) {
  if (!available) return null;
  return (
    <div className="w-full mb-2 break-inside-avoid">
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => e.key === "Enter" && onClick()}
        className="rounded-lg border border-border/50 bg-card overflow-hidden cursor-pointer hover:bg-muted/50 hover:border-border transition-colors"
      >
        <div className="flex items-center gap-2.5 px-3 py-2.5">
          <div
            className={cn(
              "w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0",
              iconBg,
            )}
          >
            {icon}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-foreground">{label}</div>
            <div className="text-[11px] text-muted-foreground mt-0.5 truncate">{sub}</div>
          </div>
          {badge && (
            <span
              className={cn(
                "text-[10px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0",
                badgeClass,
              )}
            >
              {badge}
            </span>
          )}
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/40 flex-shrink-0" />
        </div>
        {children && (
          <div className="px-3 pb-3 pt-0 border-t border-border/30">
            <div className="pt-2">{children}</div>
          </div>
        )}
      </div>
    </div>
  );
}

/** An action inside a card. */
export function CardAction({
  icon: Icon,
  label,
  hint,
  variant,
  disabled,
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  hint?: string;
  /** `seed` asks the agent and is borderless; `direct` acts itself and carries a border. */
  variant: "seed" | "direct";
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "flex items-center gap-2 w-full text-[11px] text-left rounded-md transition-colors",
        variant === "seed"
          ? "px-1.5 py-1 -mx-1.5 text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground"
          : "px-2.5 py-1.5 border border-border bg-background enabled:hover:bg-muted",
        disabled && "opacity-40 cursor-default",
      )}
    >
      <Icon className="w-3.5 h-3.5 flex-shrink-0" />
      <span className="truncate">{label}</span>
      {hint && <span className="ml-auto text-[9.5px] opacity-70 flex-shrink-0">{hint}</span>}
    </button>
  );
}

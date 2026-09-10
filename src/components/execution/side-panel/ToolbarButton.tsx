import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";

/**
 * The Files tab's icon buttons, which were otherwise a dozen copies of the same class strings in
 * as many sizes.
 *
 * Rendered through `Button` rather than styled by hand so that `disabled` reaches the DOM: base-ui
 * turns a `disabled` prop on `TooltipTrigger` itself into `data-trigger-disabled` and leaves the
 * element clickable, which is why the open and download buttons could be pressed again mid-transfer.
 * Icons must carry a `size-*` class — `Button` forces `size-4` onto any `svg` that does not.
 *
 * It lives beside `file-edit-utils.ts` rather than inside either of its two callers, so the header
 * and the file panel import it instead of one importing from the other.
 */
export function ToolbarButton({
  label,
  tooltip,
  active,
  disabled,
  size = "icon-sm",
  className,
  onClick,
  children,
}: {
  /** Accessible name, and the tooltip when `tooltip` is not given. */
  label: string;
  tooltip?: React.ReactNode;
  /** Omit for a button that acts rather than toggles — it decides whether `aria-pressed` is set. */
  active?: boolean;
  disabled?: boolean;
  /** 32px in the header, 24px beside the file panel's filter field. */
  size?: "icon-sm" | "icon-xs";
  className?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size={size}
            aria-label={label}
            {...(active === undefined ? {} : { "aria-pressed": active })}
            disabled={disabled}
            onClick={onClick}
            className={cn(
              "text-muted-foreground hover:text-foreground",
              active && "bg-muted/60 text-foreground",
              className,
            )}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{tooltip ?? label}</TooltipContent>
    </Tooltip>
  );
}

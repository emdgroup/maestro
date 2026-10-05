import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/ui/dialog";
import { cn } from "@/lib/utils";

interface HomeSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The small uppercase line over the title, e.g. `On devbox`. */
  eyebrow?: ReactNode;
  title: ReactNode;
  /** Shows a back arrow before the title when the sheet is a second step. */
  onBack?: () => void;
  /** `glass-strong` in the design: for confirmations, read over moving bubbles. */
  strong?: boolean;
  className?: string;
  children: ReactNode;
}

/** A dialog of Home: a glass sheet over the blurred scrim, eyebrow over a `2xl` title. */
export function HomeSheet({
  open,
  onOpenChange,
  eyebrow,
  title,
  onBack,
  strong,
  className,
  children,
}: HomeSheetProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        overlayClassName="home-scrim bg-transparent supports-backdrop-filter:backdrop-blur-none"
        className={cn(
          strong ? "home-pop-strong" : "home-pop",
          "block rounded-[22px] bg-transparent p-6 ring-0 sm:max-w-[560px]",
          "[&>[data-slot=dialog-close]]:top-5 [&>[data-slot=dialog-close]]:right-5 [&>[data-slot=dialog-close]]:rounded-full",
          className,
        )}
      >
        <div className="flex items-start pr-8">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label="Back"
              className="mt-3 mr-2 grid size-7 cursor-pointer place-items-center rounded-full text-muted-foreground hover:bg-foreground/10"
            >
              <ChevronLeft className="size-4" />
            </button>
          )}
          <div className="min-w-0">
            {eyebrow && (
              <DialogDescription className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
                {eyebrow}
              </DialogDescription>
            )}
            <DialogTitle className="mt-0.5 text-2xl font-semibold tracking-[-0.025em]">
              {title}
            </DialogTitle>
          </div>
        </div>
        {children}
      </DialogContent>
    </Dialog>
  );
}

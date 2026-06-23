import { cn } from "@/lib/ui-utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="skeleton" className={cn("rounded-md skeleton-shimmer", className)} {...props} />
  );
}

export { Skeleton };

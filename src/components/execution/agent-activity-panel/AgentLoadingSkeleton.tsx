import { Skeleton } from "@/ui/skeleton";
import { cn } from "@/lib/utils.ts";
import { useSettings } from "@/services/settings.service";

export function AgentLoadingSkeleton({ isNewSession }: { isNewSession?: boolean }) {
  const { data: appSettings } = useSettings();
  const isCompact = appSettings?.agent_stream_width === "compact";

  if (isNewSession) {
    return (
      <div className="flex-1 flex flex-col min-h-0 relative">
        <div className="absolute inset-0 flex items-center justify-center px-8">
          <Skeleton className="h-12 w-[min(48rem,100%)] rounded-3xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-1 p-3 space-y-3">
        <div className="flex items-start gap-2.5">
          <Skeleton className="w-7 h-7 rounded-lg shrink-0" />
          <div className="flex-1 min-w-0 space-y-3">
            <div className="space-y-2">
              <Skeleton className="h-4 w-[70%]" />
              <Skeleton className="h-4 w-[45%]" />
            </div>
            <Skeleton className="h-9 w-56 rounded-lg" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-[55%]" />
              <Skeleton className="h-4 w-[35%]" />
            </div>
          </div>
        </div>
      </div>
      <div className={cn("pb-2.5 pt-1", isCompact ? "px-3" : "px-16")}>
        <Skeleton className="h-18 w-full rounded-3xl" />
      </div>
    </div>
  );
}

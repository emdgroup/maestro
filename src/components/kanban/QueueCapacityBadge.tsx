import { Cpu } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { Badge } from "@/ui/badge";
import { cn } from "@/lib/utils";
import { useQueueCapacityQuery } from "@/services/execution.service";

/**
 * How many agent slots this project's host has, and how many are taken.
 *
 * This exists because of a deliberate design choice that would otherwise look like a bug: a
 * session parked in Review still holds a slot. That is back-pressure — it stops the farm
 * outrunning the reviewer — but without showing it, a queue that has stopped moving because three
 * reviews are open is indistinguishable from one that is broken.
 */
export function QueueCapacityBadge({ projectId }: { projectId: number | null }) {
  const { data } = useQueueCapacityQuery(projectId);

  if (!data) return null;

  const full = data.used >= data.slots;

  return (
    <Tooltip>
      {/* A badge rather than a button: there is nothing to click, and a focusable element with no
          action is a trap for keyboard users. Full is a normal state — back-pressure working — so
          it is distinguished quietly rather than being made to look like a fault. */}
      <TooltipTrigger
        render={
          <Badge
            variant={full ? "outline" : "ghost"}
            className={cn(
              "h-6 px-2.5 font-normal [&>svg]:size-4!",
              !full && "hover:bg-transparent",
            )}
          />
        }
      >
        <Cpu className="text-accent" />
        <span>
          <span className="font-semibold tabular-nums">{data.used}</span> of {data.slots}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        Agent slots in use. A task in Review keeps its slot. {data.reason}
        {full && data.slots > 0 && ". The queue waits until one frees"}
      </TooltipContent>
    </Tooltip>
  );
}

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { Cpu } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { Badge } from "@/ui/badge";
import { api } from "@/lib/tauri-utils";

/// Matches `useQueueDrain`, for the same reason and against the same events: one transition emits
/// several of them, and answering each separately means several `get_queue_capacity` calls for one
/// change. `tasks-changed` alone fires on every permission prompt and every answer to one.
const DEBOUNCE_MS = 400;

/**
 * How many agent slots this project's host has, and how many are taken.
 *
 * This exists because of a deliberate design choice that would otherwise look like a bug: a
 * session parked in Review still holds a slot. That is back-pressure — it stops the farm
 * outrunning the reviewer — but without showing it, a queue that has stopped moving because three
 * reviews are open is indistinguishable from one that is broken.
 */
export function QueueCapacityBadge({ projectId }: { projectId: number | null }) {
  const queryClient = useQueryClient();
  const queryKey = ["queue-capacity", projectId] as const;

  useEffect(() => {
    if (projectId === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The same events that trigger a drain change the answer here.
    const unlisteners = ["tasks-changed", "sessions-changed", "settings-changed"].map((event) =>
      listen(event, () => {
        clearTimeout(timer);
        timer = setTimeout(() => void queryClient.invalidateQueries({ queryKey }), DEBOUNCE_MS);
      }),
    );
    return () => {
      clearTimeout(timer);
      for (const unlisten of unlisteners) {
        void unlisten.then((fn) => fn());
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, queryClient]);

  const { data } = useQuery({
    queryKey,
    queryFn: () => api.getQueueCapacity(projectId!),
    enabled: projectId !== null,
  });

  if (!data) return null;

  const full = data.used >= data.slots;

  return (
    <Tooltip>
      {/* A badge rather than a button: there is nothing to click, and a focusable element with no
          action is a trap for keyboard users. Full is a normal state — back-pressure working — so
          it is distinguished quietly rather than being made to look like a fault. */}
      <TooltipTrigger
        render={<Badge variant={full ? "outline" : "secondary"} className="h-8 px-2.5" />}
      >
        <Cpu />
        {data.used}/{data.slots}
      </TooltipTrigger>
      <TooltipContent>
        {data.reason}
        {full && data.slots > 0 && ". The queue waits until one frees"}
      </TooltipContent>
    </Tooltip>
  );
}

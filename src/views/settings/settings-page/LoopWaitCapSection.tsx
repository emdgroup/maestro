import { Repeat } from "lucide-react";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { useLoopWaitCap, useSetLoopWaitCap } from "@/services/settings.service";

/** How many loops may wait on the user before auto mode starts no more of the queued ones. */
export function LoopWaitCapSection({ projectId }: { projectId: number }) {
  const { data: cap } = useLoopWaitCap(projectId);
  const setCap = useSetLoopWaitCap();

  if (cap === undefined) return null;

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-3">
      <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
        <Repeat className="w-4 h-4 text-muted-foreground" />
        Loops
      </h3>
      <div className="flex items-center gap-3">
        <Label htmlFor="loop-wait-cap" className="text-sm font-medium">
          At most
        </Label>
        <Input
          id="loop-wait-cap"
          type="number"
          min={0}
          max={99}
          value={cap}
          onChange={(e) => {
            const parsed = Number.parseInt(e.target.value, 10);
            if (Number.isFinite(parsed)) {
              setCap.mutate({ projectId, cap: Math.max(0, Math.min(99, parsed)) });
            }
          }}
          className="h-8 w-20"
        />
        <span className="text-sm">loops waiting on me</span>
      </div>
      <p className="text-xs text-muted-foreground">
        Once this many loops wait for your answer or your check, auto mode starts no more queued
        loops until you have dealt with one. Start anyway on a queued loop starts it regardless. 0
        means no limit.
      </p>
    </div>
  );
}

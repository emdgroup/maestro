import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { useLoopWaitCap, useSetLoopWaitCap } from "@/services/settings.service";

/**
 * How many loops may wait on the user before auto mode starts no more of the queued ones. Shown
 * under the Loops tab of the agents section.
 */
export function LoopWaitCapSection({ projectId }: { projectId: number }) {
  const { data: cap } = useLoopWaitCap(projectId);
  const setCap = useSetLoopWaitCap();

  if (cap === undefined) return null;

  return (
    <div className="rounded-2xl border border-foreground/7 bg-card p-4 space-y-2">
      <h4 className="text-sm font-semibold">Waiting on you</h4>
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

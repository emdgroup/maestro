import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/ui/hover-card";
import { getLifecycle, subscribeSession } from "@/components/execution/activity/sessionRuntime";
import {
  PLAN_WINDOWS,
  elapsedShare,
  formatCountdown,
  liveWindows,
  planLimitsKey,
  usePlanLimitsStore,
  windowTone,
  type PlanLimits,
  type PlanWindowId,
  type WindowTone,
} from "@/components/execution/activity/planLimits";

const FILL: Record<WindowTone, string> = {
  ok: "bg-success",
  ahead: "bg-warning",
  reached: "bg-destructive",
};
const TEXT: Record<WindowTone, string> = {
  ok: "text-foreground",
  ahead: "text-warning",
  reached: "text-destructive",
};
/** What has already passed of the window, so the fill reads against the time it was spent in. */
const HATCH = {
  backgroundImage:
    "repeating-linear-gradient(135deg, rgb(255 255 255 / 0.16) 0 2px, transparent 2px 4px)",
};
const OVERAGE_REASON: Record<string, string> = {
  org_level_disabled: "disabled by your organisation",
  org_level_disabled_until: "disabled by your organisation",
  out_of_credits: "out of credits",
  overage_not_provisioned: "not set up on this plan",
};

function Track({
  usage,
  elapsed,
  tone,
  className,
}: {
  usage: number;
  elapsed: number;
  tone: WindowTone;
  className: string;
}) {
  return (
    <div className={cn("relative overflow-hidden rounded-full bg-foreground/[0.07]", className)}>
      <div className="absolute inset-y-0 left-0" style={{ ...HATCH, width: `${elapsed * 100}%` }} />
      <div
        className={cn("absolute inset-y-0 left-0 rounded-full", FILL[tone])}
        style={{ width: `${Math.min(usage, 1) * 100}%` }}
      />
    </div>
  );
}

function money({ amount, currency }: { amount: number; currency: string }) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/**
 * The session's cost and its agent's plan limits, on the right of the session header. Each window
 * is labelled with the time left before it resets, and its track hatches what has passed of it.
 */
export function SessionUsageMeters({
  sessionId,
  agentId,
  connectionId,
}: {
  sessionId: string;
  agentId: string | null;
  connectionId: string;
}) {
  const subscribe = useCallback((fn: () => void) => subscribeSession(sessionId, fn), [sessionId]);
  const cost = useSyncExternalStore(subscribe, () => getLifecycle(sessionId).usageState?.cost);
  const limits = usePlanLimitsStore((s) =>
    agentId ? s.byAgent[planLimitsKey(connectionId, agentId)] : undefined,
  );

  // Ticks whether or not a reading has arrived, so the first one is never drawn against a stale
  // clock. One header is mounted at a time.
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, []);

  const windows = liveWindows(limits, now);
  if (!cost && windows.length === 0) return null;

  return (
    <HoverCard>
      <HoverCardTrigger
        render={
          <div
            className="flex items-center gap-3 rounded-md px-2 py-1 transition-colors hover:bg-muted/50"
            aria-label="Session cost and plan limits"
          />
        }
      >
        {cost && (
          <span className="text-[11px] tabular-nums text-muted-foreground">{money(cost)}</span>
        )}
        {cost && windows.length > 0 && <span className="h-5 w-px bg-border" />}
        {limits && windows.map((id) => <WindowMeter key={id} limits={limits} id={id} now={now} />)}
      </HoverCardTrigger>
      <HoverCardContent align="end" className="w-72 space-y-3 p-3.5 text-[11px]">
        {cost && (
          <div>
            <div className="flex justify-between">
              <span className="text-xs font-semibold">This session</span>
              <span className="font-semibold tabular-nums">{money(cost)}</span>
            </div>
            <div className="text-[10px] text-muted-foreground">
              As the agent reports it. On a subscription this is the API-price equivalent, not a
              charge.
            </div>
          </div>
        )}
        {limits && windows.length > 0 && (
          <PlanDetails limits={limits} windows={windows} now={now} divided={!!cost} />
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

function WindowMeter({ limits, id, now }: { limits: PlanLimits; id: PlanWindowId; now: number }) {
  const w = limits.windows[id]!;
  const tone = windowTone(limits, id, now);
  return (
    <div className="w-20 text-[10px]" title={`${PLAN_WINDOWS[id].label}, time to reset`}>
      <div className="flex justify-between">
        <span className="tabular-nums text-muted-foreground">
          {formatCountdown(w.resetsAt - now)}
        </span>
        <span className={cn("font-medium tabular-nums", TEXT[tone])}>
          {tone === "reached" ? "Limit" : `${Math.round(w.utilization * 100)}%`}
        </span>
      </div>
      <Track
        usage={w.utilization}
        elapsed={elapsedShare(w, id, now)}
        tone={tone}
        className="mt-1.5 h-1"
      />
    </div>
  );
}

function PlanDetails({
  limits,
  windows,
  now,
  divided,
}: {
  limits: PlanLimits;
  windows: PlanWindowId[];
  now: number;
  divided: boolean;
}) {
  const overage =
    limits.overageStatus === "rejected"
      ? `Extra usage off${limits.overageDisabledReason && OVERAGE_REASON[limits.overageDisabledReason] ? ` (${OVERAGE_REASON[limits.overageDisabledReason]})` : ""}. `
      : "";
  return (
    <div className={cn("space-y-3", divided && "border-t pt-2.5")}>
      <div className="text-xs font-semibold">Claude plan limits</div>
      {windows.map((id) => {
        const w = limits.windows[id]!;
        const tone = windowTone(limits, id, now);
        const at = new Date(w.resetsAt * 1000).toLocaleString(undefined, {
          weekday: w.resetsAt - now > 86400 ? "short" : undefined,
          hour: "2-digit",
          minute: "2-digit",
        });
        return (
          <div key={id} className="space-y-1.5">
            <div className="flex justify-between">
              <span>{PLAN_WINDOWS[id].label}</span>
              <span className={cn("font-medium tabular-nums", tone !== "ok" && TEXT[tone])}>
                {Math.round(w.utilization * 100)}%
              </span>
            </div>
            <Track
              usage={w.utilization}
              elapsed={elapsedShare(w, id, now)}
              tone={tone}
              className="h-1.5"
            />
            <div className="text-[10px] text-muted-foreground">
              {tone === "reached" ? "Reached. " : ""}Resets {at}, in{" "}
              {formatCountdown(w.resetsAt - now)}
            </div>
          </div>
        );
      })}
      <div className="border-t pt-2 text-[10px] text-muted-foreground">
        {overage}Shared by every Claude session on this connection. Updated{" "}
        {formatCountdown(now - limits.receivedAt / 1000)} ago.
      </div>
    </div>
  );
}

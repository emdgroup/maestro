import { create } from "zustand";

/** One of the plan's usage windows. `utilization` is a fraction of the window's budget. */
export type PlanWindow = { utilization: number; resetsAt: number };

export const PLAN_WINDOWS = {
  fiveHour: { label: "5-hour window", seconds: 5 * 3600 },
  sevenDay: { label: "Weekly, all models", seconds: 7 * 86400 },
} as const;
export type PlanWindowId = keyof typeof PLAN_WINDOWS;

/**
 * Claude's plan limits as `claude-agent-acp` attaches them to `usage_update`, under
 * `_meta["_claude/rateLimit"]`, with each reply. Times are unix seconds. They belong to the account
 * the agent runs as, not to the session that carried them.
 */
export type PlanLimits = {
  status: string;
  /** The window `status` and `resetsAt` speak about. */
  rateLimitType: string | null;
  resetsAt: number | null;
  windows: Partial<Record<PlanWindowId, PlanWindow>>;
  overageStatus: string | null;
  overageDisabledReason: string | null;
  /** When it arrived, in ms. */
  receivedAt: number;
};

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function planWindow(v: unknown): PlanWindow | undefined {
  const w = obj(v);
  const utilization = num(w?.utilization);
  const resetsAt = num(w?.resetsAt);
  return utilization == null || resetsAt == null ? undefined : { utilization, resetsAt };
}

/** The plan limits a session update carries, if it carries any. */
export function parsePlanLimits(raw: Record<string, unknown>, now = Date.now()): PlanLimits | null {
  const info = obj(obj(raw._meta)?.["_claude/rateLimit"]);
  const status = str(info?.status);
  if (!info || !status) return null;
  const unified = obj(info.unifiedWindows);
  const windows: PlanLimits["windows"] = {};
  const fiveHour = planWindow(unified?.five_hour);
  const sevenDay = planWindow(unified?.seven_day);
  if (fiveHour) windows.fiveHour = fiveHour;
  if (sevenDay) windows.sevenDay = sevenDay;
  return {
    status,
    rateLimitType: str(info.rateLimitType),
    resetsAt: num(info.resetsAt),
    windows,
    overageStatus: str(info.overageStatus),
    overageDisabledReason: str(info.overageDisabledReason),
    receivedAt: now,
  };
}

function windowOf(rateLimitType: string | null): PlanWindowId | null {
  if (rateLimitType === "five_hour") return "fiveHour";
  if (rateLimitType?.startsWith("seven_day")) return "sevenDay";
  return null;
}

export type WindowTone = "ok" | "ahead" | "reached";

/**
 * Ahead once a larger share of the budget is spent than of the window, rather than past a fixed
 * threshold: 85% with minutes to go is fine, 40% ten minutes in is not.
 */
export function windowTone(limits: PlanLimits, id: PlanWindowId, nowSec: number): WindowTone {
  const w = limits.windows[id];
  const named = windowOf(limits.rateLimitType) === id;
  if ((named && limits.status === "rejected") || (w && w.utilization >= 1)) return "reached";
  if (named && limits.status === "allowed_warning") return "ahead";
  return w && w.utilization > elapsedShare(w, id, nowSec) ? "ahead" : "ok";
}

/** How much of the window has passed, 0 to 1. */
export function elapsedShare(w: PlanWindow, id: PlanWindowId, nowSec: number): number {
  const left = (w.resetsAt - nowSec) / PLAN_WINDOWS[id].seconds;
  return Math.min(1, Math.max(0, 1 - left));
}

/** `1d 4h`, `2h 05m`, `12m`, and seconds only in the last minute. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  if (s >= 3600) {
    return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  }
  if (s >= 60) return `${Math.floor(s / 60)}m`;
  return `${s}s`;
}

/** The windows still running: a reading says nothing once its window has reset. */
export function liveWindows(limits: PlanLimits | undefined, nowSec: number): PlanWindowId[] {
  if (!limits) return [];
  return (Object.keys(PLAN_WINDOWS) as PlanWindowId[]).filter((id) => {
    const w = limits.windows[id];
    return w != null && w.resetsAt > nowSec;
  });
}

/** The notice a refused reply owes the session, or null when the plan still allows it. */
export function limitReachedNotice(
  limits: PlanLimits,
): { title: string; description: string } | null {
  if (limits.status !== "rejected") return null;
  const id = windowOf(limits.rateLimitType);
  const which =
    id === "fiveHour" ? "5-hour limit" : id === "sevenDay" ? "weekly limit" : "usage limit";
  const resetsAt = limits.resetsAt ?? (id ? limits.windows[id]?.resetsAt : undefined);
  return {
    title: `Claude ${which} reached`,
    description: resetsAt
      ? `Resets ${new Date(resetsAt * 1000).toLocaleString(undefined, {
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit",
        })}. Prompts sent before then are refused.`
      : "Prompts are refused until it resets.",
  };
}

/** The latest reading per agent per connection, which every session of that agent there shares. */
export const usePlanLimitsStore = create<{
  byAgent: Record<string, PlanLimits>;
  record: (key: string, limits: PlanLimits) => void;
}>((set) => ({
  byAgent: {},
  record: (key, limits) =>
    set((s) =>
      (s.byAgent[key]?.receivedAt ?? -1) >= limits.receivedAt
        ? s
        : { byAgent: { ...s.byAgent, [key]: limits } },
    ),
}));

export const planLimitsKey = (connectionId: string, agentId: string) =>
  `${connectionId}|${agentId}`;

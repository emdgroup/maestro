import type { DeliveryOutcome, WebhookDelivery } from "@/types/bindings";
import type { RunEntry } from "./runs";

export const OUTCOME: Record<DeliveryOutcome, { label: string; tone: string }> = {
  started: { label: "Started a run", tone: "text-emerald-600" },
  queued: { label: "Queued", tone: "text-muted-foreground" },
  busy: { label: "Refused: a run was going", tone: "text-amber-600" },
  queue_full: { label: "Refused: queue full", tone: "text-amber-600" },
  rate_limited: { label: "Refused: too many", tone: "text-amber-600" },
  unauthorized: { label: "Wrong or missing secret", tone: "text-destructive" },
  duplicate: { label: "Ignored: already received", tone: "text-muted-foreground" },
  disabled: { label: "Refused: switched off", tone: "text-amber-600" },
  too_large: { label: "Refused: body over 1 MB", tone: "text-destructive" },
  failed: { label: "Could not start", tone: "text-destructive" },
};

/**
 * Deliveries that started no run, and so have no run row of their own to be seen in.
 *
 * A started or queued delivery is its run, and a duplicate is the sender retrying one that was:
 * none of them is something the user has to act on.
 */
export function refusedDeliveries(deliveries: WebhookDelivery[]): WebhookDelivery[] {
  return deliveries.filter(
    (delivery) => !["started", "queued", "duplicate"].includes(delivery.outcome),
  );
}

export type HistoryItem =
  | { kind: "run"; at: string; entry: RunEntry }
  | { kind: "delivery"; at: string; delivery: WebhookDelivery };

/** One automation's runs and refused deliveries, newest first. */
export function automationHistory(runs: RunEntry[], deliveries: WebhookDelivery[]): HistoryItem[] {
  return [
    ...runs.map((entry): HistoryItem => ({ kind: "run", at: entry.run.started_at, entry })),
    ...refusedDeliveries(deliveries).map((delivery): HistoryItem => ({
      kind: "delivery",
      at: delivery.received_at,
      delivery,
    })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

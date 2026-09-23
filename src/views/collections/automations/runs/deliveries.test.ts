import { describe, expect, it } from "vitest";
import type { AutomationRun, DeliveryOutcome, WebhookDelivery } from "@/types/bindings";
import { entriesOf } from "./runs";
import { automationHistory } from "./deliveries";

const at = (seconds: number) => new Date(seconds * 1000).toISOString();

const delivery = (id: string, outcome: DeliveryOutcome, seconds: number): WebhookDelivery => ({
  id,
  received_at: at(seconds),
  status: 409,
  outcome,
});

describe("automationHistory", () => {
  it("puts refused deliveries among the runs by time, and leaves out those a run stands for", () => {
    const runs = entriesOf(
      [
        { id: "r2", started_at: at(30), status: "succeeded", trigger: "webhook" },
        { id: "r1", started_at: at(10), status: "succeeded", trigger: "webhook" },
      ] as AutomationRun[],
      [],
      {},
    );
    const history = automationHistory(runs, [
      delivery("started", "started", 30),
      delivery("queued", "queued", 25),
      delivery("duplicate", "duplicate", 22),
      delivery("busy", "busy", 20),
      delivery("unauthorized", "unauthorized", 40),
    ]);
    expect(
      history.map((item) => (item.kind === "run" ? item.entry.run.id : item.delivery.id)),
    ).toEqual(["unauthorized", "r2", "busy", "r1"]);
  });
});

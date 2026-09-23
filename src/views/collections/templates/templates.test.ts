import { describe, expect, it } from "vitest";
import { localTimezone } from "@/views/collections/automations/schedule";
import {
  BUILTIN_TEMPLATES,
  automationFieldsOf,
  describeTrigger,
  searchCards,
  triggerType,
  userCard,
} from "./templates";

describe("templates", () => {
  it("fills a built-in's missing zone with this computer's, and keeps a stored one", () => {
    const builtin = BUILTIN_TEMPLATES[0];
    expect(automationFieldsOf(builtin.name, builtin.body).timezone).toBe(localTimezone());

    const own = userCard({
      id: 1,
      name: "Mine",
      created_at: "2026-01-01",
      body: {
        kind: "automation",
        prompt: "do it",
        cron: null,
        timezone: "Asia/Tokyo",
        webhook_enabled: true,
        webhook_overlap: "queue",
      },
    });
    expect(own.body).not.toHaveProperty("kind");
    expect(automationFieldsOf(own.name, own.body)).toMatchObject({
      name: "Mine",
      timezone: "Asia/Tokyo",
      webhook_enabled: true,
      webhook_overlap: "queue",
    });
    expect(describeTrigger(own.body)).toBe("Webhook");
  });

  it("searches name, description and category", () => {
    expect(searchCards(BUILTIN_TEMPLATES, "security").map((card) => card.name)).toContain(
      "Scan for vulnerabilities",
    );
    expect(searchCards(BUILTIN_TEMPLATES, "  ")).toHaveLength(BUILTIN_TEMPLATES.length);
  });

  it("gives every built-in a unique key and a readable trigger", () => {
    expect(new Set(BUILTIN_TEMPLATES.map((card) => card.key)).size).toBe(BUILTIN_TEMPLATES.length);
    for (const card of BUILTIN_TEMPLATES.filter((card) => card.body.cron)) {
      expect(describeTrigger(card.body)).not.toBe(card.body.cron);
      expect(triggerType(card.body).label).toBe("Schedule");
    }
  });
});

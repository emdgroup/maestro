import {
  Bug,
  BookOpen,
  CalendarClock,
  Cog,
  FlaskConical,
  GitPullRequest,
  LayoutTemplate,
  ListTodo,
  Mail,
  Newspaper,
  Package,
  Play,
  Search,
  ShieldAlert,
  TestTubeDiagonal,
  Webhook,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { describeSchedule, localTimezone } from "@/views/collections/automations/schedule";
import builtins from "../../../../src-tauri/assets/builtin-templates.json";
import type { Automation, AutomationTemplate, Template, TemplateBody } from "@/types/bindings";

/**
 * One card on the Templates page: a built-in or one of the user's own, drawn the same way.
 *
 * Only automations exist as a kind today, so `body` is an automation's. A second kind makes this a
 * union on `body.kind`, and the card keeps its shape.
 */
export type TemplateKind = TemplateBody["kind"];

export interface TemplateCard {
  key: string;
  kind: TemplateKind;
  name: string;
  description: string;
  /** A topic, shown first in the footer. Optional on the user's own. */
  tag: string | null;
  icon: LucideIcon;
  body: AutomationTemplate;
  /** Set for the user's own, which are the only ones that can be edited or deleted. */
  stored: Template | null;
}

/** The kinds a template can be of, each with the icon the Templates page shows it by. */
export const TEMPLATE_KIND = {
  automation: { label: "Automation template", plural: "Automations", icon: Cog },
} satisfies Record<TemplateKind, { label: string; plural: string; icon: LucideIcon }>;

/** What kind of trigger an automation made from this gets, for a chip: no schedule sentence. */
export function triggerType(body: AutomationTemplate): { label: string; icon: LucideIcon } {
  if (body.cron) return { label: "Schedule", icon: CalendarClock };
  if (body.webhook_enabled) return { label: "Webhook", icon: Webhook };
  return { label: "On demand", icon: Play };
}

/** "Every day at 09:00", "Webhook" or "On demand": what starts an automation made from this. */
export function describeTrigger(body: AutomationTemplate): string {
  if (body.cron) return describeSchedule(body.cron);
  return body.webhook_enabled ? "Webhook" : "On demand";
}

/** What a template keeps of an automation: what it does and what starts it, nothing of the project. */
export function templateOf(automation: Automation): AutomationTemplate {
  return {
    prompt: automation.prompt,
    cron: automation.cron ?? null,
    timezone: automation.timezone,
    webhook_enabled: automation.webhook_enabled,
    webhook_overlap: automation.webhook_overlap,
  };
}

/** The fields a template fills in on a new automation. The rest are the project's defaults. */
export function automationFieldsOf(
  name: string,
  body: AutomationTemplate,
): Pick<
  Automation,
  "name" | "prompt" | "cron" | "timezone" | "webhook_enabled" | "webhook_overlap"
> {
  return {
    name,
    prompt: body.prompt,
    cron: body.cron ?? null,
    // A built-in carries no zone: "09:00" means wherever it is being set up.
    timezone: body.timezone || localTimezone(),
    webhook_enabled: body.webhook_enabled,
    webhook_overlap: body.webhook_overlap,
  };
}

export function userCard(template: Template): TemplateCard {
  // The prompt stands in for a description: it is the whole of what the template does.
  const { kind: _kind, ...body } = template.body;
  return {
    key: `user-${template.id}`,
    kind: template.body.kind,
    name: template.name,
    description: body.prompt,
    tag: template.tag ?? null,
    icon: LayoutTemplate,
    body,
    stored: template,
  };
}

/** The lucide icon each built-in names in `builtin-templates.json`. */
const BUILTIN_ICONS: Record<string, LucideIcon> = {
  Bug,
  BookOpen,
  FlaskConical,
  GitPullRequest,
  ListTodo,
  Mail,
  Newspaper,
  Package,
  Search,
  ShieldAlert,
  TestTubeDiagonal,
  Wrench,
};

/**
 * Shipped with Maestro and read-only. Kept in a JSON asset rather than here because the agent's
 * template tools read the same list from Rust. Each prompt says what to leave behind and when to
 * stop, since an unattended run has nobody to ask either.
 */
export const BUILTIN_TEMPLATES: TemplateCard[] = builtins.templates.map((entry) => {
  const { kind, ...body } = entry.body as TemplateBody;
  return {
    key: `builtin-${entry.key}`,
    kind,
    name: entry.name,
    description: entry.description,
    tag: entry.tag,
    icon: BUILTIN_ICONS[entry.icon] ?? LayoutTemplate,
    body,
    stored: null,
  };
});

/** Cards whose name, description or tag contain the query, case-insensitively. */
export function searchCards(cards: TemplateCard[], query: string): TemplateCard[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return cards;
  return cards.filter((card) =>
    [card.name, card.description, card.tag ?? ""].some((text) =>
      text.toLowerCase().includes(needle),
    ),
  );
}

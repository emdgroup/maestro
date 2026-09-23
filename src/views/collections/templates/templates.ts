import {
  Ban,
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
  Search,
  ShieldAlert,
  TestTubeDiagonal,
  Webhook,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { describeSchedule, localTimezone } from "@/views/collections/automations/schedule";
import type { Automation, AutomationTemplate, Template, TemplateBody } from "@/types/bindings";

/**
 * One card on the Templates page: a built-in or one of the user's own, drawn the same way.
 *
 * Only automations exist as a kind today, so `body` is an automation's. A second kind makes this a
 * union on `body.kind`, and the card keeps its shape.
 */
export interface TemplateCard {
  key: string;
  name: string;
  description: string;
  /** A topic, shown first in the footer. Only built-ins have one. */
  tag: string | null;
  icon: LucideIcon;
  body: AutomationTemplate;
  /** Set for the user's own, which are the only ones that can be edited or deleted. */
  stored: Template | null;
}

/** The kinds a template can be of, each with the icon the Templates page shows it by. */
export const TEMPLATE_KIND = {
  automation: { label: "Automation template", icon: Cog },
} satisfies Record<TemplateBody["kind"], { label: string; icon: LucideIcon }>;

/** What kind of trigger an automation made from this gets, for a chip: no schedule sentence. */
export function triggerType(body: AutomationTemplate): { label: string; icon: LucideIcon } {
  if (body.cron) return { label: "Schedule", icon: CalendarClock };
  if (body.webhook_enabled) return { label: "Webhook", icon: Webhook };
  return { label: "No trigger", icon: Ban };
}

/** "Every day at 09:00", "Webhook" or "No trigger": what starts an automation made from this. */
export function describeTrigger(body: AutomationTemplate): string {
  if (body.cron) return describeSchedule(body.cron);
  return body.webhook_enabled ? "Webhook" : "No trigger";
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
    name: template.name,
    description: body.prompt,
    tag: null,
    icon: LayoutTemplate,
    body,
    stored: template,
  };
}

function builtin(
  key: string,
  name: string,
  tag: string,
  icon: LucideIcon,
  description: string,
  trigger: Pick<AutomationTemplate, "cron" | "webhook_enabled" | "webhook_overlap">,
  prompt: string,
): TemplateCard {
  return {
    key: `builtin-${key}`,
    name,
    description,
    tag,
    icon,
    body: { prompt, timezone: "", ...trigger },
    stored: null,
  };
}

const NONE = { cron: null, webhook_enabled: false, webhook_overlap: "refuse" } as const;
const at = (cron: string) => ({ ...NONE, cron });
const webhook = (overlap: AutomationTemplate["webhook_overlap"]) =>
  ({ cron: null, webhook_enabled: true, webhook_overlap: overlap }) as const;

/**
 * Shipped with Maestro and read-only. Each prompt says what to leave behind and when to stop,
 * since an unattended run has nobody to ask either.
 */
export const BUILTIN_TEMPLATES: TemplateCard[] = [
  builtin(
    "critical-bugs",
    "Find critical bugs",
    "Code quality",
    Bug,
    "Analyze recent commits for high-severity correctness bugs and submit safe fixes.",
    at("0 6 * * 1-5"),
    `Review the commits made in the last 24 hours for high-severity correctness bugs: crashes, data loss, wrong results, broken error handling, race conditions and security mistakes. Ignore style and minor issues.

For each bug you are confident about, fix it with the smallest safe change, add a test that fails without the fix, and commit it on its own with a message that explains the bug. Leave anything you are unsure about unfixed and describe it instead.

End with a short report: what you fixed, what you suspect but did not touch, and why. If you found nothing, say so and stop.`,
  ),
  builtin(
    "daily-summary",
    "Summarize changes daily",
    "Status reports",
    Mail,
    "Write a daily digest of notable repository changes and risks from the previous day.",
    at("0 8 * * 1-5"),
    `Summarize what changed in this repository since yesterday morning. Read the commits and their diffs, not just the messages.

Write a digest a teammate can read in two minutes: the notable changes grouped by area, anything risky or surprising (large refactors, removed checks, new dependencies, schema or config changes), and anything that looks unfinished. Do not modify any files. If nothing changed, say so in one line.`,
  ),
  builtin(
    "vulnerabilities",
    "Scan for vulnerabilities",
    "Security",
    ShieldAlert,
    "Review the repository on a schedule and report validated high-impact security issues.",
    at("0 7 * * 1"),
    `Review this repository for high-impact security issues: injection, broken authentication or authorization, secrets committed to the code, unsafe deserialization, path traversal, SSRF and insecure defaults.

Only report issues you have validated by reading the code path end to end, with the file, the line, how it can be reached and what an attacker gains. Rank them by impact. Do not change any files. If you find nothing of high impact, say so rather than listing minor findings.`,
  ),
  builtin(
    "test-coverage",
    "Add test coverage",
    "Code quality",
    FlaskConical,
    "Review recent changes and add tests for high-risk logic that lacks coverage.",
    at("0 3 * * 6"),
    `Look at the code changed in the last week and find high-risk logic with no tests: branching business rules, parsing, money or permission checks, error paths.

Write focused tests for the most important gaps, following the conventions of the existing test suite. Run them and make sure they pass. If a test reveals a bug, do not fix it: keep the test, mark it as expected to fail or skipped with a comment, and report the bug. Commit the tests, and end with a list of what you covered and what you left.`,
  ),
  builtin(
    "fix-reported-bugs",
    "Fix reported bugs",
    "Incidents & triage",
    Wrench,
    "Investigate the bug report you give it, reproduce it, and fix it in a commit.",
    NONE,
    `Fix the bug described below.

Reproduce it first, with a failing test where possible. Find the root cause rather than patching the symptom, fix it with the smallest change that does it, and check that the rest of the test suite still passes. Commit the fix and the test together, with a message that explains the cause.

If you cannot reproduce it, stop and report what you tried and what you would need to know.

Bug report:
`,
  ),
  builtin(
    "generate-docs",
    "Generate docs",
    "Documentation",
    BookOpen,
    "Create and update developer documentation for recently changed or under-documented code.",
    at("0 4 * * 5"),
    `Find code changed in the last week whose documentation is missing or now out of date: public functions, modules, configuration, commands, and the README or docs pages that describe them.

Update the documentation to match what the code does today, in the style the project already uses. Explain why where it is not obvious, not what each line does. Do not change any code. Commit the documentation changes and list what you updated.`,
  ),
  builtin(
    "dependency-check",
    "Dependency check",
    "Maintenance",
    Package,
    "List outdated and vulnerable dependencies with the upgrade each needs. Report only.",
    at("0 7 * * 1-5"),
    `Check this project's dependencies with the package managers it uses. List the ones that are outdated or have known vulnerabilities.

For each, give the current version, the version to move to, whether that is a breaking upgrade, and what in this codebase it would affect. Put vulnerable ones first. Do not change any files. If everything is up to date, say so in one line.`,
  ),
  builtin(
    "failing-tests",
    "Fix failing tests",
    "Code quality",
    TestTubeDiagonal,
    "Run the test suite, and fix what fails in a commit. Stops if everything passes.",
    at("0 2 * * *"),
    `Run the project's test suite. If everything passes, say so and stop.

For each failure, find out whether the test or the code is wrong. Fix the code when the test describes the intended behaviour, and the test when the behaviour changed on purpose. Never delete or skip a test to make it pass. Commit each fix separately with the reason, and end with what you fixed and anything you could not.`,
  ),
  builtin(
    "review-pull-request",
    "Review a pull request",
    "Code review",
    GitPullRequest,
    "Triggered by a GitHub pull_request event: review the diff and summarize the findings.",
    webhook("parallel"),
    `A GitHub pull_request event is attached below. If the action is not "opened", "reopened" or "synchronize", stop.

Fetch the pull request's head branch and review its diff against the base branch. Look for bugs, missing error handling, risky changes and missing tests, and check that it does what its description says. Do not change any files.

Write a review: a one-paragraph summary, then each finding with the file and line, why it matters and what to do about it, most important first.`,
  ),
  builtin(
    "ci-failure",
    "Investigate a CI failure",
    "Incidents & triage",
    Search,
    "Triggered by a failed workflow run: find the failing step, reproduce it, and fix it.",
    webhook("queue"),
    `A CI event describing a workflow run is attached below. If the run did not fail, stop.

Find the failing job and step, read its log if you can reach it, and reproduce the failure locally on the same commit. Work out whether it is a real bug, a flaky test or an environment problem.

For a real bug, fix it and commit the fix. For a flaky test or an environment problem, do not change anything; explain the cause and what would make it reliable.`,
  ),
  builtin(
    "weekly-changelog",
    "Weekly changelog",
    "Status reports",
    Newspaper,
    "Group last week's commits into features, fixes and chores, as a draft for release notes.",
    at("0 9 * * 1"),
    `Read every commit from the last seven days and write a changelog draft for them.

Group entries under Features, Fixes and Chores, one line each, written for someone who uses the project rather than someone who wrote it. Merge commits that belong to the same change into one entry, and leave out anything nobody would notice. Do not modify any files.`,
  ),
  builtin(
    "todo-sweep",
    "TODO sweep",
    "Planning",
    ListTodo,
    "Rank TODO and FIXME comments by worth, and turn the top few into Maestro tasks.",
    NONE,
    `Find every TODO, FIXME and HACK comment in this repository. For each, read the code around it and judge whether it still applies, how much it matters and how much work it is.

Create a Maestro task for each of the five most worthwhile, with a title, what needs doing, why, and the file and line. Do not change any files. End with the full ranked list, including the ones you did not turn into tasks and why.`,
  ),
];

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

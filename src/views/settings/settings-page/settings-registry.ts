import { Bell, Bot, CircleDot, Cpu, GitBranch, Monitor, Palette, ScrollText } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * Which store a page writes to. This is the one thing the settings page was failing to say:
 * `app` is the `settings` table, `connection` is whatever host the project lives on, and
 * `project` is that project's `.maestro/`. A page belongs to exactly one.
 */
export type SettingsScope = "app" | "connection" | "project";

export interface SettingsPageDef {
  id: string;
  label: string;
  icon: LucideIcon;
  scope: SettingsScope;
  /**
   * The names of the controls the page renders, so search finds a setting by what it is
   * called rather than by which page someone filed it under. A control that is not listed
   * here is a control the user cannot search for.
   */
  keywords: string[];
}

// Updates are not a page: version, update state and the auto-update switch live in the
// header bar above the sidebar (`UpdateStrip`), because "am I up to date" is a status the
// user wants answered on arrival rather than one they navigate to.
export const SETTINGS_PAGES: SettingsPageDef[] = [
  {
    id: "appearance",
    label: "Appearance",
    icon: Monitor,
    scope: "app",
    keywords: [
      "system title bar",
      "window frame",
      "global default color",
      "accent color",
      "new projects",
      "ui scale",
      "font size",
      "terminal colors",
      "enter key behavior",
    ],
  },
  {
    id: "notifications",
    label: "Notifications",
    icon: Bell,
    scope: "app",
    keywords: ["agent finished", "agent needs you", "agent failed", "desktop alerts"],
  },
  {
    id: "concurrency",
    label: "Running agents",
    icon: Cpu,
    scope: "app",
    keywords: ["max concurrent agents", "concurrency", "auto mode", "free memory", "queue"],
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    icon: ScrollText,
    scope: "app",
    keywords: ["log level", "log location", "log directory", "trace", "bug report", "debug"],
  },
  {
    id: "project-defaults",
    label: "Defaults",
    icon: GitBranch,
    scope: "project",
    keywords: [
      "default agent",
      "installed agents",
      "authentication",
      "sign in",
      "log out",
      "default workspace",
      "worktree",
      "repository directory",
    ],
  },
  {
    id: "agent-profiles",
    label: "Agent pipeline",
    icon: Bot,
    scope: "project",
    keywords: ["profiles", "roles", "planner", "coder", "reviewer", "skills", "mcp servers"],
  },
  {
    id: "issue-tracking",
    label: "Issue tracking",
    icon: CircleDot,
    scope: "project",
    keywords: ["jira", "github", "gitlab", "linear", "azure devops", "gitea", "forgejo", "issues"],
  },
  {
    id: "project-appearance",
    label: "Appearance",
    icon: Palette,
    scope: "project",
    keywords: ["project color", "accent color", "header color"],
  },
];

/**
 * Nearest scope first. What a user came to Settings to change is nearly always about the
 * project in front of them; the application-wide preferences are the ones they set once.
 *
 * `connection` currently has no pages — the agent list moved back beside the default agent it
 * sets, and splitting them cost more than the scope purity bought. The scope stays because a
 * per-host setting is a real thing to have; the sidebar renders no heading for an empty group,
 * so it costs nothing until something fills it.
 */
export const SCOPE_ORDER: SettingsScope[] = ["project", "connection", "app"];

/** The registry in the order the sidebar shows it, so "the first page" means the same thing. */
export function orderedPages(pages: SettingsPageDef[]): SettingsPageDef[] {
  return SCOPE_ORDER.flatMap((scope) => pages.filter((page) => page.scope === scope));
}

export interface SettingsSearchHit {
  page: SettingsPageDef;
  /** Keywords that matched, so the sidebar can say *why* a page is in the results. */
  matched: string[];
}

/**
 * Pages matching `query`, in registry order.
 *
 * A blank query returns everything with no matched terms — the sidebar's normal state, not a
 * special case it has to check for separately.
 */
export function searchSettings(pages: SettingsPageDef[], query: string): SettingsSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return pages.map((page) => ({ page, matched: [] }));

  return pages.flatMap((page) => {
    const matched = page.keywords.filter((k) => k.toLowerCase().includes(q));
    // A page whose own name matches is a hit even when no individual control does, and its
    // keywords are not evidence for that match, so they are not listed.
    if (page.label.toLowerCase().includes(q)) return [{ page, matched: [] }];
    return matched.length > 0 ? [{ page, matched }] : [];
  });
}

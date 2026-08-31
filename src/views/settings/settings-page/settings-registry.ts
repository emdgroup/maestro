import { Bell, Bot, CircleDot, Cpu, GitBranch, Monitor, Palette, ScrollText } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * What a page's settings apply to. This is the one thing the settings page was failing to say:
 * `app` is every project on this machine, `connection` is one host and everything pointed at it,
 * and `project` is a single project. A page belongs to exactly one.
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
    // Per connection because the constraint is memory, and a machine's memory is shared by every
    // project and every tool pointed at it.
    scope: "connection",
    keywords: ["max concurrent agents", "concurrency", "auto mode", "free memory", "queue"],
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    icon: ScrollText,
    scope: "app",
    keywords: ["log level", "log location", "log directory", "trace", "bug report", "debug"],
  },
  // One page per subject rather than one page called "Defaults": the agent default and the agent
  // pipeline were on two separate pages while the git settings hid under a generic name, so
  // picking a default meant leaving the list it comes from.
  {
    id: "agents",
    label: "Agents",
    icon: Bot,
    scope: "project",
    keywords: [
      "default agent",
      "installed agents",
      "authentication",
      "sign in",
      "log out",
      "profiles",
      "roles",
      "planner",
      "coder",
      "reviewer",
      "skills",
      "mcp servers",
    ],
  },
  {
    id: "git",
    label: "Git",
    icon: GitBranch,
    scope: "project",
    keywords: [
      "default workspace",
      "worktree",
      "repository directory",
      "base branch",
      "default branch",
      "git remote",
      "origin",
      "code hosting",
      "pull request",
      "connect github",
      "when a task is approved",
      "merge locally",
      "push only",
    ],
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
 * The sidebar renders no heading for an empty group, so a scope with no pages costs nothing —
 * which is what let `connection` sit unused until the agent limit moved into it.
 */
export const SCOPE_ORDER: SettingsScope[] = ["project", "connection", "app"];

/** The registry in the order the sidebar shows it, so "the first page" means the same thing. */
export function orderedPages(pages: SettingsPageDef[]): SettingsPageDef[] {
  return SCOPE_ORDER.flatMap((scope) => pages.filter((page) => page.scope === scope));
}

/** What the settings surface is being shown against, which is what decides its page list. */
export interface SettingsHost {
  /** False on the welcome screen, where there is no project and no connection to scope to. */
  inProject: boolean;
  /** False for a project that is not a git repository. */
  isGitRepo: boolean;
}

/**
 * The pages this host should offer, in sidebar order.
 *
 * A page with nothing to apply to is absent rather than disabled or empty. The welcome screen
 * has no project and no connection, and a project that is not a git repository has no
 * worktrees, no base branch and no remote — every control on the Git page, so the page would
 * be a heading over nothing.
 */
export function visiblePages(host: SettingsHost): SettingsPageDef[] {
  return orderedPages(
    SETTINGS_PAGES.filter(
      (page) => (host.inProject || page.scope === "app") && (page.id !== "git" || host.isGitRepo),
    ),
  );
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

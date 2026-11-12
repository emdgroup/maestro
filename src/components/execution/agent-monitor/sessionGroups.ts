import type { MonitorSession } from "@/store/fileSessionStore";
import type { SessionActivityStatus } from "@/store/sessionActivityStore";

/** Lower sorts first: a session waiting on the user, then one at work, then the rest. */
export function activityRank(status: SessionActivityStatus | undefined): number {
  if (status === "awaiting_input") return 0;
  if (status === "idle" || status === undefined) return 2;
  return 1;
}

export interface AutomationOrigin {
  id: string;
  name: string;
}

export interface SessionGroup {
  /** `task:<id>`, `automation:<id>`, or the session id for a group of one in Yours. */
  key: string;
  sessions: MonitorSession[];
}

export type SectionKey = "tasks" | "automations" | "yours";

export interface SessionSection {
  key: SectionKey;
  label: string;
  groups: SessionGroup[];
}

const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: "tasks", label: "Tasks" },
  { key: "automations", label: "Automations" },
  { key: "yours", label: "Yours" },
];

/**
 * Sort the sessions into Tasks, Automations and Yours, a task's or an automation's sessions
 * gathered under it. Inside a group, and between groups, a session waiting on the user comes
 * first, then one at work, then the newest. Empty sections are left out.
 */
export function groupSessions(
  sessions: MonitorSession[],
  automationOf: (session: MonitorSession) => AutomationOrigin | undefined,
  rankOf: (session: MonitorSession) => number,
): SessionSection[] {
  const started = (s: MonitorSession) => Date.parse(s.started_at) || 0;
  const bySession = (a: MonitorSession, b: MonitorSession) =>
    rankOf(a) - rankOf(b) || started(b) - started(a);
  const groups = new Map<string, { section: SectionKey; sessions: MonitorSession[] }>();
  for (const session of sessions) {
    const automation = session.task_id == null ? automationOf(session) : undefined;
    const [section, key]: [SectionKey, string] =
      session.task_id != null
        ? ["tasks", `task:${session.task_id}`]
        : automation
          ? ["automations", `automation:${automation.id}`]
          : ["yours", session.session_id];
    const group = groups.get(key) ?? { section, sessions: [] };
    group.sessions.push(session);
    groups.set(key, group);
  }
  return SECTIONS.flatMap(({ key, label }) => {
    const sectionGroups = [...groups]
      .filter(([, g]) => g.section === key)
      .map(([groupKey, g]) => ({ key: groupKey, sessions: g.sessions.sort(bySession) }))
      .sort((a, b) => bySession(a.sessions[0], b.sessions[0]));
    return sectionGroups.length > 0 ? [{ key, label, groups: sectionGroups }] : [];
  });
}

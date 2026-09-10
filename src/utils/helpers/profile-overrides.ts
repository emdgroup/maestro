import type { AgentRole } from "@/types/bindings";

/**
 * What a task asked for, per role: a profile id, or `null` for "skip this stage".
 *
 * Three states, not two, and the third is what an absent key cannot express. An absent key means
 * "the project decides" — the default a task is born with — so saying "not this task" needs a
 * value of its own. Hence `null` rather than an omission or an empty string.
 */
export type ProfileOverrides = Record<string, string | null>;

/**
 * Parsed defensively, because the alternative is worse. This is written by the card's override
 * dialog and read on the path that starts a task: a task that cannot be started at all is a worse
 * outcome than one that starts with the project's defaults.
 */
export function parseProfileOverrides(raw: string | null | undefined): ProfileOverrides {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as ProfileOverrides;
  } catch {
    console.warn("Ignoring unreadable profile overrides");
    return {};
  }
}

/**
 * Key presence, not truthiness. `overrides[role] ?? null` cannot tell "skip" from "no override",
 * and the two have opposite meanings — which is exactly the mistake this shape invites.
 */
export function isRoleSkipped(overrides: ProfileOverrides, role: AgentRole): boolean {
  return role in overrides && overrides[role] === null;
}

/** The profile id this task named for the role, or `null` for both "skipped" and "no override". */
export function profileIdFor(overrides: ProfileOverrides, role: AgentRole): string | null {
  return overrides[role] ?? null;
}

import type { SkillInfo } from "@/types/bindings";

/** The Agent Skills name rule: 1 to 64 lowercase letters, digits and hyphens. */
export function isSkillName(name: string): boolean {
  return /^[a-z0-9-]{1,64}$/.test(name);
}

/** Skills whose name, description or source contains the query, case-insensitively. */
export function filterSkills(skills: SkillInfo[], query: string): SkillInfo[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return skills;
  return skills.filter((skill) =>
    [skill.name, skill.description, skill.source ?? ""].some((field) =>
      field.toLowerCase().includes(needle),
    ),
  );
}

import type { SkillInfo } from "@/types/bindings";

/**
 * The Agent Skills name rule, which `validate_name` in `skills.rs` mirrors: 1 to 64 lowercase
 * letters, numbers and hyphens, with no hyphen at either end or two in a row.
 */
export function isSkillName(name: string): boolean {
  return name.length <= 64 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
}

/**
 * What the name field keeps of what is typed: lowercase, spaces and underscores as hyphens, and
 * nothing else the rule refuses. A trailing hyphen stays, since the next letter makes it valid.
 */
export function toSkillName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .slice(0, 64);
}

/**
 * The name rules what was just typed runs into: those `toSkillName` had to enforce, and a trailing
 * hyphen, which it lets through. Spaces and underscores are not listed; turning them into hyphens
 * is what the user meant.
 */
export function skillNameProblems(typed: string): string[] {
  const hyphenated = typed.replace(/[\s_]+/g, "-");
  const problems: string[] = [];
  if (/[^a-z0-9-]/.test(hyphenated)) problems.push("Lowercase letters, numbers and hyphens only");
  if (hyphenated.startsWith("-")) problems.push("No hyphen at the start");
  if (toSkillName(typed).endsWith("-")) problems.push("No hyphen at the end");
  if (hyphenated.includes("--")) problems.push("No two hyphens in a row");
  if (hyphenated.length > 64) problems.push("64 characters at most");
  return problems;
}

/**
 * The tools in an `allowed-tools` string. Space-separated per the spec, but a rule's parentheses
 * may hold spaces (`Bash(git commit:*)`), and Claude Code also takes commas, so both split only
 * outside parentheses.
 */
export function splitTools(text: string): string[] {
  const tools: string[] = [];
  let current = "";
  let depth = 0;
  for (const character of text) {
    if (character === "(") depth++;
    if (character === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (character === " " || character === ",")) {
      if (current) tools.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (current.trim()) tools.push(current.trim());
  return tools;
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

/** A skill's page on skills.sh, from its `owner/repo` source. */
export function skillPage(source: string, skillId: string): string {
  return `https://skills.sh/${source}/${skillId}`;
}

/**
 * A skill's agent map from what the agents dialog picked: `{"*": true}` for every agent, or the
 * picked ones on. An agent the skill had and lost is kept, switched off, so it can be turned back on.
 */
export function skillAgents(picked: string[], previous: Partial<Record<string, boolean>> = {}) {
  if (picked.includes("*")) return { "*": true };
  return Object.fromEntries([
    ...Object.keys(previous)
      .filter((id) => id !== "*")
      .map((id) => [id, false]),
    ...picked.map((id) => [id, true]),
  ]) as Record<string, boolean>;
}

/** Who may start a skill. Claude Code reads `disable-model-invocation` and `user-invocable`. */
export type SkillInvocation = "anyone" | "user_only" | "agent_only";

/** A `SKILL.md` as the form edits it. `extra` is every other frontmatter line, kept verbatim. */
export type SkillForm = {
  name: string;
  description: string;
  invocation: SkillInvocation;
  argumentHint: string;
  allowedTools: string;
  instructions: string;
  extra: string;
};

const FORM_KEYS = new Set([
  "name",
  "description",
  "argument-hint",
  "allowed-tools",
  "disable-model-invocation",
  "user-invocable",
]);

/** One YAML scalar: plain, single- or double-quoted, or a `>` / `|` block on the lines after. */
function scalar(first: string, rest: string[]): string {
  const value = first.trim();
  if (value === "" || value.startsWith(">") || value.startsWith("|")) {
    const lines = rest.map((line) => line.trim());
    return lines.join(value.startsWith("|") ? "\n" : " ").trim();
  }
  if (value.startsWith('"')) {
    try {
      return String(JSON.parse(value));
    } catch {
      return value;
    }
  }
  const single = /^'(.*)'$/.exec(value);
  return single ? single[1].replace(/''/g, "'") : value;
}

/**
 * The form's fields out of a `SKILL.md`, and the frontmatter it has no field for as `extra`.
 *
 * ponytail: reads single-line scalars and `>`/`|` blocks, as `parse_skill_md` in `skills.rs` does;
 * a YAML parser if skills start using anything stranger for the keys the form owns.
 */
export function parseSkillMd(text: string): SkillForm {
  const md = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const form: SkillForm = {
    name: "",
    description: "",
    invocation: "anyone",
    argumentHint: "",
    allowedTools: "",
    instructions: md.trim(),
    extra: "",
  };
  if (!md.startsWith("---\n")) return form;
  const rest = md.slice(4);
  const end = rest.search(/^---[ \t]*$/m);
  const front = end < 0 ? rest : rest.slice(0, end);
  form.instructions = end < 0 ? "" : rest.slice(end).split("\n").slice(1).join("\n").trim();

  // Each entry is a top-level key and the indented, blank or list lines under it.
  const entries: { key: string; lines: string[] }[] = [];
  for (const line of front.split("\n")) {
    const key = /^([\w-]+)\s*:/.exec(line)?.[1];
    if (key !== undefined || entries.length === 0) entries.push({ key: key ?? "", lines: [line] });
    else entries[entries.length - 1].lines.push(line);
  }
  const extra: string[] = [];
  for (const { key, lines } of entries) {
    if (!FORM_KEYS.has(key)) {
      extra.push(...lines);
      continue;
    }
    const value = scalar(lines[0].slice(lines[0].indexOf(":") + 1), lines.slice(1));
    const flag = ["true", "yes", "on", "1"].includes(value.toLowerCase());
    if (key === "name") form.name = value;
    if (key === "description") form.description = value;
    if (key === "argument-hint") form.argumentHint = value;
    if (key === "allowed-tools") form.allowedTools = value;
    if (key === "disable-model-invocation" && flag) form.invocation = "user_only";
    if (key === "user-invocable" && !flag && form.invocation === "anyone")
      form.invocation = "agent_only";
  }
  form.extra = extra.join("\n").trim();
  return form;
}

/**
 * The form as a `SKILL.md`: its own keys first, then `extra` as it was. A JSON string is a valid
 * YAML double-quoted scalar, which makes it the one quoting that needs no rules of its own.
 */
export function renderSkillMd(form: SkillForm): string {
  const quote = (text: string) => JSON.stringify(text.trim());
  const front = [`name: ${form.name}`, `description: ${quote(form.description)}`];
  if (form.allowedTools.trim()) front.push(`allowed-tools: ${quote(form.allowedTools)}`);
  // A hint for a command nobody can type would only mislead.
  if (form.argumentHint.trim() && form.invocation !== "agent_only")
    front.push(`argument-hint: ${quote(form.argumentHint)}`);
  if (form.invocation === "user_only") front.push("disable-model-invocation: true");
  if (form.invocation === "agent_only") front.push("user-invocable: false");
  if (form.extra.trim()) front.push(form.extra.trim());
  return `---\n${front.join("\n")}\n---\n\n${form.instructions.trim()}\n`;
}

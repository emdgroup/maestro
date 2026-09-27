import { describe, expect, it } from "vitest";
import {
  filterSkills,
  isSkillName,
  parseSkillMd,
  renderSkillMd,
  skillAgents,
  skillNameProblems,
  splitTools,
  toSkillName,
} from "./skills";
import type { SkillInfo } from "@/types/bindings";

const skill = (name: string, patch: Partial<SkillInfo> = {}): SkillInfo => ({
  name,
  description: "",
  skill_md: "",
  source: null,
  agents: {},
  ...patch,
});

describe("isSkillName", () => {
  it("follows the Agent Skills rule", () => {
    expect(isSkillName("pdf-tools-2")).toBe(true);
    for (const bad of ["", "PDF", "a_b", "a/b", "-a", "a-", "a--b", "x".repeat(65)])
      expect(isSkillName(bad)).toBe(false);
  });
});

describe("toSkillName", () => {
  it("keeps only what the rule allows as the user types", () => {
    expect(toSkillName("My PDF_Tools!")).toBe("my-pdf-tools");
    expect(toSkillName("--a  b--")).toBe("a-b-");
    expect(toSkillName("x".repeat(70))).toHaveLength(64);
  });
});

describe("splitTools", () => {
  it("splits on spaces and commas outside parentheses", () => {
    expect(splitTools("Read  Grep,Bash(git commit:*) WebFetch")).toEqual([
      "Read",
      "Grep",
      "Bash(git commit:*)",
      "WebFetch",
    ]);
    expect(splitTools(" ")).toEqual([]);
  });
});

describe("skillNameProblems", () => {
  it("names only the rules the typed text broke", () => {
    expect(skillNameProblems("my skill")).toEqual([]);
    expect(skillNameProblems("My-")).toEqual([
      "Lowercase letters, numbers and hyphens only",
      "No hyphen at the end",
    ]);
    expect(skillNameProblems("-a--b")).toEqual([
      "No hyphen at the start",
      "No two hyphens in a row",
    ]);
    expect(skillNameProblems("x".repeat(65))).toEqual(["64 characters at most"]);
  });
});

describe("filterSkills", () => {
  it("matches name, description and source", () => {
    const skills = [
      skill("pdf", { source: "anthropics/skills" }),
      skill("mine", { description: "Deploy the site" }),
    ];
    expect(filterSkills(skills, "ANTHROPICS").map((s) => s.name)).toEqual(["pdf"]);
    expect(filterSkills(skills, "deploy").map((s) => s.name)).toEqual(["mine"]);
    expect(filterSkills(skills, " ")).toHaveLength(2);
  });
});

describe("skillAgents", () => {
  it("keeps agents a skill loses, switched off", () => {
    expect(skillAgents(["*"], { codex: true })).toEqual({ "*": true });
    expect(skillAgents(["codex"], { "*": true, auggie: true })).toEqual({
      auggie: false,
      codex: true,
    });
  });
});

describe("SKILL.md", () => {
  it("keeps frontmatter the form has no field for", () => {
    const md = [
      "---",
      "name: pdf",
      "description: >",
      "  Read PDFs",
      "  and fill forms.",
      "license: 'Apache-2.0'",
      "metadata:",
      "  version: 2",
      "user-invocable: no",
      "argument-hint: '[file]'",
      "---",
      "# PDF",
    ].join("\r\n");
    const form = parseSkillMd(md);
    expect(form).toEqual({
      name: "pdf",
      description: "Read PDFs and fill forms.",
      invocation: "agent_only",
      argumentHint: "[file]",
      allowedTools: "",
      instructions: "# PDF",
      extra: "license: 'Apache-2.0'\nmetadata:\n  version: 2",
    });
    const written = renderSkillMd({ ...form, invocation: "user_only" });
    expect(written).toBe(
      '---\nname: pdf\ndescription: "Read PDFs and fill forms."\nargument-hint: "[file]"\ndisable-model-invocation: true\nlicense: \'Apache-2.0\'\nmetadata:\n  version: 2\n---\n\n# PDF\n',
    );
    expect(parseSkillMd(written)).toEqual({ ...form, invocation: "user_only" });
  });

  it("reads a file without frontmatter as instructions", () => {
    expect(parseSkillMd("just text")).toMatchObject({ name: "", instructions: "just text" });
  });
});

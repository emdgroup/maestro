import { describe, expect, it } from "vitest";
import { filterSkills, isSkillName } from "./skills";
import type { SkillInfo } from "@/types/bindings";

const skill = (name: string, patch: Partial<SkillInfo> = {}): SkillInfo => ({
  name,
  description: "",
  instructions: "",
  source: null,
  agents: {},
  ...patch,
});

describe("isSkillName", () => {
  it("follows the Agent Skills rule", () => {
    expect(isSkillName("pdf-tools-2")).toBe(true);
    for (const bad of ["", "PDF", "a_b", "a/b", "x".repeat(65)])
      expect(isSkillName(bad)).toBe(false);
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

import { describe, expect, it } from "vitest";
import { allTags, filterPrompts } from "./prompts";
import type { Prompt } from "@/types/bindings";

function prompt(id: number, fields: Partial<Prompt>): Prompt {
  return {
    id,
    title: `Prompt ${id}`,
    body: "",
    tags: [],
    shared: false,
    favorite: false,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
    ...fields,
  };
}

const prompts = [
  prompt(1, { title: "Review changes", tags: ["review"], shared: true, favorite: true }),
  prompt(2, { body: "Write tests for HEAD", tags: ["tests", "review"] }),
  prompt(3, { title: "Explain module", shared: true }),
];
const ids = (list: Prompt[]) => list.map((p) => p.id);

describe("filterPrompts", () => {
  it("filters by kind", () => {
    expect(ids(filterPrompts(prompts, "all", null, ""))).toEqual([1, 2, 3]);
    expect(ids(filterPrompts(prompts, "favorites", null, ""))).toEqual([1]);
    expect(ids(filterPrompts(prompts, "shared", null, ""))).toEqual([1, 3]);
    expect(ids(filterPrompts(prompts, "project", null, ""))).toEqual([2]);
  });

  it("combines tag and query, matching title, text or tag", () => {
    expect(ids(filterPrompts(prompts, "all", "review", ""))).toEqual([1, 2]);
    expect(ids(filterPrompts(prompts, "all", "review", "tests"))).toEqual([2]);
    expect(ids(filterPrompts(prompts, "all", null, "  EXPLAIN "))).toEqual([3]);
    expect(ids(filterPrompts(prompts, "shared", "tests", ""))).toEqual([]);
  });
});

it("allTags is unique and sorted", () => {
  expect(allTags(prompts)).toEqual(["review", "tests"]);
});

import type { Prompt } from "@/types/bindings";

export type PromptFilter = "all" | "favorites" | "shared" | "project";

/** Prompts matching the filter, the tag and the query (title, text or tag, case-insensitive). */
export function filterPrompts(
  prompts: Prompt[],
  filter: PromptFilter,
  tag: string | null,
  query: string,
): Prompt[] {
  const needle = query.trim().toLowerCase();
  return prompts.filter(
    (prompt) =>
      (filter === "all" ||
        (filter === "favorites" && prompt.favorite) ||
        (filter === "shared" && prompt.shared) ||
        (filter === "project" && !prompt.shared)) &&
      (tag === null || prompt.tags.includes(tag)) &&
      (!needle ||
        [prompt.title, prompt.body, ...prompt.tags].some((text) =>
          text.toLowerCase().includes(needle),
        )),
  );
}

/** Every tag in use, sorted, for the tag bar and the editor's suggestions. */
export function allTags(prompts: Prompt[]): string[] {
  return [...new Set(prompts.flatMap((prompt) => prompt.tags))].sort();
}

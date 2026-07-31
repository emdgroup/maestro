import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { renderHook, act } from "@testing-library/react";
import { useRef } from "react";
import { useCommandAutocomplete } from "./useCommandAutocomplete";
import { CommandSuggestionsPanel } from "./CommandSuggestionsPanel";
import type { AvailableCommand } from "../types";

// Shape seen in real sessions: namespaced names, and four names sent twice
// (the plugin registers each as both a skill and a slash command).
const COMMANDS: AvailableCommand[] = [
  { name: "caveman:caveman-commit", description: "a" },
  { name: "caveman:caveman-commit", description: "b" },
  { name: "caveman:caveman-review", description: "a" },
  { name: "caveman:caveman-review", description: "b" },
  { name: "code-review:code-review", description: "" },
  { name: "ponytail:ponytail-review", description: "" },
  { name: "security-review", description: "" },
  { name: "review", description: "" },
  { name: "run", description: "" },
];

function typeCommand(text: string) {
  const { result } = renderHook(() => useCommandAutocomplete({ commands: COMMANDS }));
  for (let i = 1; i <= text.length; i++) {
    act(() => {
      result.current.onInputChange(text.slice(0, i), i);
    });
  }
  return result.current.filteredCommands.map((c) => c.name);
}

describe("useCommandAutocomplete filtering", () => {
  it("matches a namespaced command by its bare name, exact match first", () => {
    expect(typeCommand("/review")).toEqual([
      "review",
      "code-review:code-review",
      "security-review",
      "caveman:caveman-review",
      "caveman:caveman-review",
      "ponytail:ponytail-review",
    ]);
  });

  it("ignores separators, so `-` matches the `:` in the real name", () => {
    expect(typeCommand("/ponytail-review")).toEqual(["ponytail:ponytail-review"]);
    expect(typeCommand("/commit")).toEqual(["caveman:caveman-commit", "caveman:caveman-commit"]);
  });

  it("closes on prose or a path", () => {
    const { result } = renderHook(() => useCommandAutocomplete({ commands: COMMANDS }));
    act(() => {
      result.current.onInputChange("/usr/local", 10);
    });
    expect(result.current.showCommands).toBe(false);
  });
});

function Panel({ commands }: { commands: AvailableCommand[] }) {
  const refs = useRef<Map<number, HTMLButtonElement>>(new Map());
  return (
    <CommandSuggestionsPanel
      commands={commands}
      highlight={0}
      panelPos={{ top: 0, left: 0, width: 300 }}
      buttonRefs={refs}
      onSelect={() => {}}
    />
  );
}

describe("CommandSuggestionsPanel", () => {
  // Duplicate names used to collide as React keys, which left the removed rows in
  // the DOM: the panel kept showing commands the filter had already dropped.
  it("drops rows the filter removed even when names repeat", () => {
    const { rerender } = render(<Panel commands={COMMANDS} />);
    rerender(<Panel commands={[{ name: "review", description: "" }]} />);
    const rows = Array.from(document.querySelectorAll("button")).map((b) => b.textContent);
    expect(rows).toEqual(["/review"]);
  });
});

import { useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { splitTools } from "./skills";

/** Claude Code's usual tools, offered as the user types. Anything else is accepted as typed. */
const SUGGESTIONS: { tool: string; hint: string }[] = [
  { tool: "Read", hint: "Read files" },
  { tool: "Edit", hint: "Edit files" },
  { tool: "Write", hint: "Create files" },
  { tool: "Grep", hint: "Search file contents" },
  { tool: "Glob", hint: "Find files by name" },
  { tool: "Bash", hint: "Any shell command" },
  { tool: "Bash(git:*)", hint: "git commands only" },
  { tool: "WebFetch", hint: "Fetch a URL" },
  { tool: "WebSearch", hint: "Search the web" },
];

/**
 * The tools a skill may use without asking, as chips. Enter, comma or a space outside
 * parentheses ends one; Backspace on an empty field takes the last back; a pasted string is split
 * the way the frontmatter is.
 */
export function ToolsInput({
  tools,
  onChange,
}: {
  tools: string[];
  onChange: (tools: string[]) => void;
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  // Whether the arrows picked a suggestion, so Enter on an empty field does not add one unasked.
  const [browsing, setBrowsing] = useState(false);

  const needle = text.trim().toLowerCase();
  const matches = SUGGESTIONS.filter(
    (suggestion) =>
      !tools.includes(suggestion.tool) && suggestion.tool.toLowerCase().includes(needle),
  );
  const add = (added: string[]) => {
    onChange([...tools, ...added.filter((tool) => !tools.includes(tool))]);
    setText("");
    setHighlight(0);
    setBrowsing(false);
  };
  const unclosed = (text.match(/\(/g)?.length ?? 0) > (text.match(/\)/g)?.length ?? 0);

  return (
    <div className="relative">
      <div className="flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-border bg-transparent px-1.5 py-1 shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30">
        {tools.map((tool) => (
          <span
            key={tool}
            className="flex items-center gap-0.5 rounded bg-muted py-px pr-0.5 pl-1.5 font-mono text-[11px]"
          >
            {tool}
            <button
              type="button"
              aria-label={`Remove ${tool}`}
              className="rounded text-muted-foreground hover:text-foreground"
              onClick={() => onChange(tools.filter((kept) => kept !== tool))}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          aria-label="Allowed tools"
          value={text}
          placeholder={tools.length ? "" : "Tools the agent may use without asking"}
          className="min-w-24 flex-1 bg-transparent px-1 font-mono text-xs outline-none placeholder:font-sans placeholder:text-muted-foreground"
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onChange={(event) => {
            setText(event.target.value);
            setHighlight(0);
            setOpen(true);
          }}
          onPaste={(event) => {
            const pasted = splitTools(event.clipboardData.getData("text"));
            if (pasted.length > 1) {
              event.preventDefault();
              add(pasted);
            }
          }}
          onKeyDown={(event) => {
            const suggestion = open ? matches[highlight] : undefined;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setBrowsing(true);
              setHighlight((highlight + step + matches.length) % Math.max(matches.length, 1));
            } else if (event.key === "Enter" && (needle || (browsing && suggestion))) {
              event.preventDefault();
              // A rule being typed out, `Bash(npm:*)`, is the user's own and not a suggestion.
              const typed = !browsing && text.includes("(");
              add([suggestion && !typed ? suggestion.tool : text.trim()]);
            } else if ((event.key === "," || (event.key === " " && !unclosed)) && needle) {
              event.preventDefault();
              add([text.trim()]);
            } else if (event.key === "Backspace" && text === "" && tools.length) {
              onChange(tools.slice(0, -1));
            } else if (event.key === "Escape" && open) {
              event.stopPropagation();
              setOpen(false);
            }
          }}
        />
      </div>
      {open && matches.length > 0 && (
        <div className="absolute inset-x-0 top-full z-10 mt-1 max-h-56 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md">
          {matches.map((suggestion, index) => (
            <button
              key={suggestion.tool}
              type="button"
              // Before the input's blur, which would close the list under the click.
              onMouseDown={(event) => {
                event.preventDefault();
                add([suggestion.tool]);
              }}
              onMouseEnter={() => setHighlight(index)}
              className={cn(
                "flex w-full items-center justify-between gap-4 rounded px-2 py-1 text-left text-xs",
                index === highlight && "bg-accent text-accent-foreground",
              )}
            >
              <span className="font-mono">{suggestion.tool}</span>
              <span className="text-[11px] text-muted-foreground">{suggestion.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

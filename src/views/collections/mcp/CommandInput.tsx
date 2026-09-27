import { useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { openQuote, quoteArg, splitCommand } from "./mcp";

const CHIP = "flex items-center gap-0.5 rounded py-px pr-0.5 pl-1.5 font-mono text-[11px]";

/**
 * A command line as chips, the first the command and the rest its arguments. Space ends one
 * unless a quote is open, a pasted line is split, and a chip clicked is edited where it stands.
 * `onPasteJson` takes a pasted JSON config instead.
 */
export function CommandInput({
  tokens,
  onChange,
  onPasteJson,
}: {
  tokens: string[];
  onChange: (tokens: string[]) => void;
  onPasteJson: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<{ index: number; text: string } | null>(null);

  const add = (typed: string) => {
    onChange([...tokens, ...splitCommand(typed)]);
    setText("");
  };
  // The edited text replaces its chip, split into as many as it now holds; empty removes it.
  const commit = () => {
    if (!editing) return;
    onChange([
      ...tokens.slice(0, editing.index),
      ...splitCommand(editing.text),
      ...tokens.slice(editing.index + 1),
    ]);
    setEditing(null);
  };
  const ends = (key: string, typed: string) =>
    key === "Enter" || (key === " " && !openQuote(typed));

  return (
    <div
      className="flex min-h-8 cursor-text flex-wrap items-center gap-1 rounded-md border border-border bg-transparent px-1.5 py-1 shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          event.preventDefault();
          event.currentTarget.querySelector<HTMLInputElement>("input[data-tail]")?.focus();
        }
      }}
    >
      {tokens.map((token, index) =>
        editing?.index === index ? (
          <input
            // oxlint-disable-next-line react/no-array-index-key -- a position, not an identity
            key={index}
            autoFocus
            aria-label={index === 0 ? "Command" : `Argument ${index}`}
            value={editing.text}
            size={Math.max(editing.text.length, 2)}
            className="rounded bg-transparent px-1.5 py-px font-mono text-[11px] outline outline-1 outline-ring"
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setEditing({ index, text: event.target.value })}
            onBlur={commit}
            onKeyDown={(event) => {
              if (ends(event.key, editing.text)) {
                event.preventDefault();
                commit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setEditing(null);
              }
            }}
          />
        ) : (
          <span
            // oxlint-disable-next-line react/no-array-index-key -- a position, not an identity
            key={index}
            title={index === 0 ? "Command" : undefined}
            className={cn(
              CHIP,
              "cursor-pointer whitespace-pre",
              index === 0 ? "bg-primary/15 font-semibold" : "bg-muted",
              /\$\{\w+\}/.test(token) && "outline outline-1 outline-dashed outline-amber-500",
            )}
            onClick={() => setEditing({ index, text: quoteArg(token) })}
          >
            {token}
            <button
              type="button"
              aria-label={`Remove ${token}`}
              className="rounded text-muted-foreground hover:text-foreground"
              onClick={(event) => {
                event.stopPropagation();
                onChange(tokens.filter((_, kept) => kept !== index));
              }}
            >
              <X className="size-3" />
            </button>
          </span>
        ),
      )}
      <input
        data-tail
        aria-label={tokens.length ? "Add an argument" : "Command"}
        value={text}
        placeholder={tokens.length ? "" : "npx -y @modelcontextprotocol/server-filesystem"}
        className="min-w-32 flex-1 bg-transparent px-1 font-mono text-xs outline-none placeholder:text-muted-foreground"
        onChange={(event) => setText(event.target.value)}
        onBlur={() => text.trim() && !openQuote(text) && add(text)}
        onPaste={(event) => {
          const pasted = event.clipboardData.getData("text").trim();
          if (pasted.startsWith("{")) {
            event.preventDefault();
            onPasteJson(pasted);
          } else if (/\s/.test(pasted)) {
            event.preventDefault();
            add(text + pasted);
          }
        }}
        onKeyDown={(event) => {
          if (ends(event.key, text) && text.trim()) {
            event.preventDefault();
            add(text);
          } else if (event.key === "Backspace" && text === "" && tokens.length) {
            event.preventDefault();
            setEditing({ index: tokens.length - 1, text: quoteArg(tokens[tokens.length - 1]) });
          }
        }}
      />
    </div>
  );
}

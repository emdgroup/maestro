import { useState, type KeyboardEvent } from "react";
import { BookText, ChevronLeft, ChevronRight, Paperclip, Plus, Search, Star } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { cn } from "@/lib/utils";
import { usePromptsQuery } from "@/services/prompt.service";
import type { Prompt } from "@/types/bindings";
import {
  DESC_CLASS,
  GLASS_CONTENT_CLASS,
  ITEM_TEXT_CLASS,
} from "../config-selectors/BaseDropdownSelector";

interface Props {
  disabled: boolean;
  /** The session's project, whose prompt collection is listed beside the shared one. */
  projectId: number | null;
  onAttach: () => void;
  onInsertPrompt: (body: string) => void;
}

// The compose bar's other menus (model, agent, mode) are base-ui Selects styled with ITEM_CLASS;
// these are plain buttons, so hover and focus stand in for its `data-highlighted`.
const ROW_CLASS =
  "group relative flex w-full cursor-default items-start gap-2 rounded-[10px] p-2 text-left outline-hidden select-none hover:bg-foreground/7 focus-visible:bg-foreground/7";

/** The compose bar's "+": attach files, or put a saved prompt in the box. */
export function AddMenu({ disabled, projectId, onAttach, onInsertPrompt }: Props) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"menu" | "prompts">("menu");

  const close = () => {
    setOpen(false);
    setView("menu");
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        // Escape in the picker steps back to the menu rather than closing both.
        if (!next && details.reason === "escape-key" && view === "prompts") {
          setView("menu");
          return;
        }
        if (next) setOpen(true);
        else close();
      }}
    >
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
          <PopoverTrigger
            disabled={disabled}
            aria-label="Add to message"
            className={cn(
              "w-7 h-7 rounded-full flex items-center justify-center text-muted-foreground border border-transparent hover:border-border/40 hover:text-accent hover:bg-accent/8 disabled:opacity-20 disabled:cursor-not-allowed transition-all duration-150",
              open && "text-accent bg-accent/8",
            )}
          >
            <Plus
              className={cn("w-3.5 h-3.5 transition-transform duration-150", open && "rotate-45")}
            />
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Attach files or insert a prompt</TooltipContent>
      </Tooltip>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        className={cn(GLASS_CONTENT_CLASS, "gap-0 p-0", view === "menu" ? "w-64" : "w-120")}
      >
        {view === "menu" ? (
          <div
            role="menu"
            className="p-1.5"
            onKeyDown={(e) => {
              if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
              e.preventDefault();
              const items = [...e.currentTarget.querySelectorAll("button")];
              const i = items.indexOf(document.activeElement as HTMLButtonElement);
              const step = e.key === "ArrowDown" ? 1 : items.length - 1;
              items[(i + step) % items.length]?.focus();
            }}
          >
            <button
              type="button"
              role="menuitem"
              autoFocus
              className={ROW_CLASS}
              onClick={() => {
                close();
                onAttach();
              }}
            >
              <Paperclip className="mt-px size-3 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className={ITEM_TEXT_CLASS}>Attach files</span>
                <span className={DESC_CLASS}>Images, text or PDFs. Paste and drop work too</span>
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              className={ROW_CLASS}
              onClick={() => setView("prompts")}
            >
              <BookText className="mt-px size-3 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className={ITEM_TEXT_CLASS}>Insert prompt</span>
                <span className={DESC_CLASS}>From this project or the shared collection</span>
              </span>
              <ChevronRight className="mt-px size-3 shrink-0 text-muted-foreground" />
            </button>
          </div>
        ) : (
          <PromptPicker
            projectId={projectId}
            onBack={() => setView("menu")}
            onPick={(prompt) => {
              close();
              onInsertPrompt(prompt.body);
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

function PromptPicker({
  projectId,
  onBack,
  onPick,
}: {
  projectId: number | null;
  onBack: () => void;
  onPick: (prompt: Prompt) => void;
}) {
  const [search, setSearch] = useState("");
  const [highlight, setHighlight] = useState(0);
  const project = usePromptsQuery(projectId, false);
  const shared = usePromptsQuery(projectId, true);

  const q = search.trim().toLowerCase();
  const matches = (p: Prompt) =>
    !q || p.title.toLowerCase().includes(q) || p.tags.some((t) => t.includes(q));
  // The backend already orders each collection favorites first, then newest.
  const groups = [
    { label: "This project", prompts: (project.data ?? []).filter(matches) },
    { label: "Shared", prompts: (shared.data ?? []).filter(matches) },
  ].filter((g) => g.prompts.length > 0);
  const flat = groups.flatMap((g) => g.prompts);
  const current = flat[Math.min(highlight, flat.length - 1)];
  const loading = project.isLoading || shared.isLoading;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter" && current) {
      e.preventDefault();
      onPick(current);
    }
  };

  let index = 0;
  return (
    <div onKeyDown={onKeyDown}>
      <div className="flex items-center gap-2 border-b border-border/30 py-2 pl-1.5 pr-3">
        <button
          type="button"
          aria-label="Back"
          onClick={onBack}
          className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-foreground/7 hover:text-foreground"
        >
          <ChevronLeft className="size-3" />
        </button>
        <Search className="size-3 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setHighlight(0);
          }}
          placeholder="Search prompts by title or tag..."
          className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div className="flex h-64">
        <div className="w-[45%] shrink-0 overflow-y-auto border-r border-border/30 p-1">
          {flat.length === 0 && (
            <p className="px-2 py-4 text-xs text-muted-foreground">
              {loading ? "Loading prompts..." : q ? "No prompts match" : "No saved prompts yet"}
            </p>
          )}
          {groups.map((group) => (
            <div key={group.label}>
              <p className="sticky top-0 z-10 bg-muted/80 px-2 py-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                {group.label}
              </p>
              {group.prompts.map((prompt) => {
                const i = index++;
                return (
                  <button
                    key={`${group.label}-${prompt.id}`}
                    type="button"
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => onPick(prompt)}
                    className={cn(
                      "flex w-full cursor-default items-center gap-1.5 rounded-[10px] p-2 text-left outline-none select-none",
                      prompt === current && "bg-foreground/7",
                    )}
                  >
                    <span
                      className={cn(
                        "truncate text-xs font-medium leading-none",
                        prompt === current && "text-accent",
                      )}
                    >
                      {prompt.title}
                    </span>
                    {prompt.favorite && (
                      <Star className="size-2.5 shrink-0 fill-amber-400 text-amber-400" />
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto p-3">
          {current && (
            <>
              <p className="truncate text-xs font-medium">{current.title}</p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {current.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full bg-foreground/7 px-1.5 py-px text-[10px] text-muted-foreground"
                  >
                    {tag}
                  </span>
                ))}
                <span className="rounded-full border border-foreground/9 px-1.5 py-px text-[10px] text-muted-foreground">
                  {current.shared ? "Shared" : "Project"}
                </span>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
                {current.body}
              </p>
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3 border-t border-border/30 px-3 py-1.5 text-[10px] text-muted-foreground">
        <span>↑↓ move</span>
        <span>Enter insert</span>
        <span>Esc back</span>
      </div>
    </div>
  );
}

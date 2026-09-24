import { useState } from "react";
import { Star, Users, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { cn } from "@/lib/utils";
import { MarkdownEditor } from "@/components/kanban/shared/MarkdownEditor";
import { useSavePromptMutation } from "@/services/prompt.service";
import type { Prompt } from "@/types/bindings";

/**
 * Creates a prompt, or edits `editing`. Tags are typed one at a time and committed with Enter or a
 * comma; ones already used elsewhere are offered, since reusing a tag is what makes it group
 * anything.
 */
export function PromptEditorDialog({
  open,
  onOpenChange,
  projectId,
  editing,
  knownTags,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: number;
  /** The prompt to edit, or `null` for a new one. */
  editing: Prompt | null;
  knownTags: string[];
}) {
  const save = useSavePromptMutation();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState("");
  const [shared, setShared] = useState(false);
  const [favorite, setFavorite] = useState(false);

  // Reset whenever the dialog opens, during render rather than from an effect, which would paint
  // one frame of whatever was there before.
  const [shownFor, setShownFor] = useState<string | null>(null);
  const current = open ? `${editing?.id ?? "new"}` : null;
  if (shownFor !== current) {
    setShownFor(current);
    if (open) {
      setTitle(editing?.title ?? "");
      setBody(editing?.body ?? "");
      setTags(editing?.tags ?? []);
      setTagDraft("");
      setShared(editing?.shared ?? false);
      setFavorite(editing?.favorite ?? false);
    }
  }

  const addTag = (raw: string) => {
    const tag = raw.trim().toLowerCase();
    if (tag && !tags.includes(tag)) setTags([...tags, tag]);
    setTagDraft("");
  };

  const valid = title.trim() !== "" && body.trim() !== "";
  const submit = () => {
    if (!valid) return;
    // A tag still being typed is one the user meant to add.
    const finalTags = tagDraft.trim() ? [...tags, tagDraft.trim().toLowerCase()] : tags;
    save.mutate(
      {
        projectId,
        prompt: { id: editing?.id ?? null, title, body, tags: finalTags, shared, favorite },
      },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
      >
        <div className="flex items-center gap-2 border-b border-border px-5 py-2.5">
          <DialogTitle className="text-[11px] font-medium text-muted-foreground">
            {editing ? "Edit prompt" : "New prompt"}
          </DialogTitle>
          <div className="ml-auto flex items-center gap-1.5">
            <Toggle
              pressed={favorite}
              onPressedChange={setFavorite}
              label="Favorite"
              hint="Starred in this project only"
              icon={<Star className={cn("size-3.5", favorite && "fill-current text-amber-500")} />}
              className={
                favorite ? "border-amber-500/60 bg-amber-500/15 text-foreground" : undefined
              }
            />
            <Toggle
              pressed={shared}
              onPressedChange={setShared}
              label="Shared"
              hint="Shared with all projects"
              icon={<Users className={cn("size-3.5", shared && "text-accent")} />}
              className={shared ? "border-accent/60 bg-accent/15 text-foreground" : undefined}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close"
              className="ml-1 text-muted-foreground"
              onClick={() => onOpenChange(false)}
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 pb-5 pt-5">
          <input
            autoFocus
            aria-label="Title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Untitled prompt"
            className="w-full bg-transparent text-lg font-semibold outline-none placeholder:text-muted-foreground/50"
          />
          <div className="h-72">
            <MarkdownEditor
              value={body}
              onSave={setBody}
              onDraftChange={setBody}
              isEditable
              fill
              placeholder="Write the prompt…"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[11px] text-muted-foreground">Tags</span>
            {tags.map((tag) => (
              <span
                key={tag}
                className="flex items-center gap-1 rounded-md bg-muted py-0.5 pl-2 pr-1 text-[11px]"
              >
                {tag}
                <button
                  type="button"
                  aria-label={`Remove tag ${tag}`}
                  onClick={() => setTags(tags.filter((t) => t !== tag))}
                  className="rounded text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
            <input
              aria-label="Tags"
              value={tagDraft}
              list="prompt-tags"
              placeholder="+ Add tag"
              onChange={(event) => {
                const value = event.target.value;
                if (value.endsWith(",")) addTag(value.slice(0, -1));
                else setTagDraft(value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addTag(tagDraft);
                } else if (event.key === "Backspace" && !tagDraft && tags.length) {
                  setTags(tags.slice(0, -1));
                }
              }}
              className="h-6 w-28 rounded-md border border-dashed border-border bg-transparent px-2 text-[11px] outline-none placeholder:text-muted-foreground focus:border-solid focus:border-ring"
            />
            <datalist id="prompt-tags">
              {knownTags
                .filter((known) => !tags.includes(known))
                .map((known) => (
                  <option key={known} value={known} />
                ))}
            </datalist>
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-border bg-muted/30 px-5 py-3">
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
            {shared
              ? "Shared with all projects. Favorite applies to this project only."
              : "Only in this project."}
          </span>
          <Button variant="ghost" className="ml-auto" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="accent" disabled={!valid || save.isPending} onClick={submit}>
            {editing ? "Save" : "Create prompt"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A pressed-or-not button in the header, with what it means in a tooltip. */
function Toggle({
  pressed,
  onPressedChange,
  label,
  hint,
  icon,
  className,
}: {
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
  label: string;
  hint: string;
  icon: React.ReactNode;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            aria-pressed={pressed}
            onClick={() => onPressedChange(!pressed)}
            className={cn("h-7 gap-1.5 text-xs", !pressed && "text-muted-foreground", className)}
          />
        }
      >
        {icon}
        {label}
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

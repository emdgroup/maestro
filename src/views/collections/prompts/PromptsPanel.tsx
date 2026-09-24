import { useState } from "react";
import { Ellipsis, MessageSquareText, Pencil, Search, Star, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/ui/alert-dialog";
import { cn } from "@/lib/utils";
import {
  useDeletePromptMutation,
  usePromptsQuery,
  useSetPromptFavoriteMutation,
  useSetPromptSharedMutation,
} from "@/services/prompt.service";
import { PromptEditorDialog } from "./PromptEditorDialog";
import { allTags, filterPrompts, type PromptFilter } from "./prompts";
import type { Prompt } from "@/types/bindings";

const FILTERS: { value: PromptFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "favorites", label: "Favorites" },
  { value: "shared", label: "Shared" },
  { value: "project", label: "This project" },
];

function copy(prompt: Prompt) {
  navigator.clipboard.writeText(prompt.body).then(
    () => toast.success(`Copied “${prompt.title}”`),
    () => toast.error("Could not copy to the clipboard"),
  );
}

function PromptCard({
  prompt,
  onFavorite,
  onShare,
  onEdit,
  onDelete,
}: {
  prompt: Prompt;
  onFavorite: () => void;
  onShare: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group relative flex flex-col gap-2 rounded-xl border border-border bg-card p-4 transition-colors hover:border-accent/60 hover:bg-muted/30">
      {/* The whole card copies, laid over it so the star and the menu can sit inside without
          nesting one control in another. */}
      <button
        type="button"
        onClick={() => copy(prompt)}
        aria-label={`Copy “${prompt.title}”`}
        className="absolute inset-0 cursor-pointer rounded-xl focus-visible:outline-2 focus-visible:outline-accent"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onFavorite}
          aria-label={prompt.favorite ? "Remove from favorites" : "Add to favorites"}
          aria-pressed={prompt.favorite}
          className={cn(
            "relative shrink-0",
            prompt.favorite
              ? "text-amber-500"
              : "text-muted-foreground/40 hover:text-muted-foreground",
          )}
        >
          <Star className={cn("size-4", prompt.favorite && "fill-current")} />
        </button>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{prompt.title}</span>
        {/* Like the star, but out of sight until the card is hovered when off, and drawn dashed
            then: a hint of what clicking would do rather than a state the prompt is in. */}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={onShare}
                aria-label={
                  prompt.shared ? "Stop sharing with all projects" : "Share with all projects"
                }
                aria-pressed={prompt.shared}
                className={cn(
                  "relative shrink-0",
                  prompt.shared
                    ? "text-accent"
                    : "text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                )}
              />
            }
          >
            <Users className={cn("size-4", !prompt.shared && "[&_*]:[stroke-dasharray:2_2.5]")} />
          </TooltipTrigger>
          <TooltipContent>
            {prompt.shared ? "Shared with all projects" : "Share with all projects"}
          </TooltipContent>
        </Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`More actions for ${prompt.title}`}
            render={
              <Button
                variant="ghost"
                size="icon"
                className="relative -my-1 size-7 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
              />
            }
          >
            <Ellipsis className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto whitespace-nowrap">
            <DropdownMenuItem className="text-xs" onClick={onEdit}>
              <Pencil className="size-3.5" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" className="text-xs" onClick={onDelete}>
              <Trash2 className="size-3.5" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p className="line-clamp-4 flex-1 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground">
        {prompt.body}
      </p>
      {prompt.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {prompt.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  prompts,
  card,
}: {
  title: string;
  prompts: Prompt[];
  card: (prompt: Prompt) => React.ReactNode;
}) {
  if (prompts.length === 0) return null;
  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        {title}
        <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
          {prompts.length}
        </span>
      </h3>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3">
        {prompts.map(card)}
      </div>
    </section>
  );
}

/**
 * The project's prompts and the shared ones, favorites first. The editor's open state is held by
 * the view, because the button that opens it for a new prompt lives in the view's action bar.
 */
export function PromptsPanel({
  projectId,
  editorOpen,
  onEditorOpenChange,
  editing,
  onEdit,
  onNew,
}: {
  projectId: number;
  editorOpen: boolean;
  onEditorOpenChange: (open: boolean) => void;
  editing: Prompt | null;
  onEdit: (prompt: Prompt) => void;
  onNew: () => void;
}) {
  const { data } = usePromptsQuery(projectId);
  const setFavorite = useSetPromptFavoriteMutation();
  const setShared = useSetPromptSharedMutation();
  const remove = useDeletePromptMutation();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PromptFilter>("all");
  const [tag, setTag] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Prompt | null>(null);

  const prompts = data ?? [];
  const tags = allTags(prompts);
  // A tag whose last prompt was deleted or retagged would otherwise filter everything away.
  const activeTag = tag !== null && tags.includes(tag) ? tag : null;
  const shown = filterPrompts(prompts, filter, activeTag, query);
  const favorites = shown.filter((prompt) => prompt.favorite);
  const others = shown.filter((prompt) => !prompt.favorite);

  const card = (prompt: Prompt) => (
    <PromptCard
      key={prompt.id}
      prompt={prompt}
      onFavorite={() =>
        setFavorite.mutate({ projectId, id: prompt.id, favorite: !prompt.favorite })
      }
      onShare={() => setShared.mutate({ projectId, id: prompt.id, shared: !prompt.shared })}
      onEdit={() => onEdit(prompt)}
      onDelete={() => setDeleting(prompt)}
    />
  );

  return (
    <div className="mr-[7px] flex h-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto rounded-t-xl border-x border-t border-border bg-background p-4">
      {prompts.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <MessageSquareText className="size-8 text-muted-foreground/40" />
          <p className="text-sm font-medium">No prompts yet</p>
          <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
            Keep the prompts you reuse here and copy them into any agent.{" "}
            <button
              type="button"
              onClick={onNew}
              className="cursor-pointer font-medium text-accent underline-offset-2 hover:underline"
            >
              Create one
            </button>{" "}
            for this project, or share it with all projects.
          </p>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search prompts…"
                aria-label="Search prompts"
                className="h-8 pl-8 text-xs"
              />
            </div>
            <ToggleGroup
              value={[filter]}
              onValueChange={(values) => {
                const next = values.find((value) => value !== filter);
                if (next) setFilter(next as PromptFilter);
              }}
              aria-label="Show"
            >
              {FILTERS.map((option) => (
                <ToggleGroupItem
                  key={option.value}
                  value={option.value}
                  size="sm"
                  variant="outline"
                  className="text-xs"
                >
                  {option.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by tag">
              {tags.map((known) => (
                <button
                  key={known}
                  type="button"
                  aria-pressed={activeTag === known}
                  onClick={() => setTag(activeTag === known ? null : known)}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[11px]",
                    activeTag === known
                      ? "border-accent bg-accent/10 text-foreground"
                      : "border-border text-muted-foreground hover:bg-muted/50",
                  )}
                >
                  {known}
                </button>
              ))}
            </div>
          )}
          {shown.length === 0 ? (
            <p className="text-xs text-muted-foreground">No prompt matches.</p>
          ) : (
            <>
              <Section title="Favorites" prompts={favorites} card={card} />
              <Section
                title={favorites.length ? "Others" : "Prompts"}
                prompts={others}
                card={card}
              />
            </>
          )}
        </>
      )}

      <PromptEditorDialog
        open={editorOpen}
        onOpenChange={onEditorOpenChange}
        projectId={projectId}
        editing={editing}
        knownTags={tags}
      />

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.shared
                ? "It is shared with all projects, so it disappears from every one of them."
                : "It is removed from this project."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleting) {
                  const title = deleting.title;
                  remove.mutate(deleting.id, {
                    onSuccess: () => toast.success(`Deleted “${title}”`),
                  });
                }
                setDeleting(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

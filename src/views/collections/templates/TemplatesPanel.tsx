import { useState } from "react";
import { Ellipsis, LayoutTemplate, Pencil, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
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
import { useAutomationsQuery } from "@/services/automation.service";
import {
  useDeleteTemplateMutation,
  useSaveTemplateMutation,
  useTemplatesQuery,
} from "@/services/template.service";
import { AutomationEditorDialog } from "@/views/collections/automations/AutomationEditorDialog";
import { localTimezone } from "@/views/collections/automations/schedule";
import {
  BUILTIN_TEMPLATES,
  automationFieldsOf,
  describeTrigger,
  searchCards,
  templateOf,
  userCard,
  type TemplateCard,
} from "./templates";
import type { Automation, ConnectionKey, Template } from "@/types/bindings";

/** Past this many, a search box earns its place above the cards. */
const SEARCH_FROM = 6;

/** A template dressed as an automation, so the automation editor can edit it. */
function asAutomation(template: Template): Automation {
  const { kind: _kind, ...body } = template.body;
  return {
    id: `template-${template.id}`,
    project_path: "",
    next_due_at: null,
    agent_id: "",
    model: null,
    permission_mode: null,
    effort: null,
    enabled: true,
    workspace: { mode: "repository" },
    ...automationFieldsOf(template.name, body),
  };
}

function Card({
  card,
  onUse,
  onEdit,
  onDelete,
}: {
  card: TemplateCard;
  onUse: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group relative flex flex-col gap-2 rounded-xl border border-border bg-card p-4 transition-colors hover:border-accent/60 hover:bg-muted/30">
      {/* The whole card is the button, laid over it, so the menu can sit inside without nesting
          one control in another. */}
      <button
        type="button"
        onClick={onUse}
        aria-label={`New automation from “${card.name}”`}
        className="absolute inset-0 rounded-xl focus-visible:outline-2 focus-visible:outline-accent"
      />
      <div className="flex items-center gap-2">
        <card.icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{card.name}</span>
        {card.stored && (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`More actions for ${card.name}`}
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="relative -my-1 size-7 shrink-0 text-muted-foreground"
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
        )}
      </div>
      <p className="line-clamp-3 flex-1 text-xs leading-relaxed text-muted-foreground">
        {card.description}
      </p>
      <p className="truncate text-[11px] text-muted-foreground/70">
        {card.category} · {describeTrigger(card.body)}
      </p>
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        {title}
        <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
          {count}
        </span>
      </h3>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3">{children}</div>
    </section>
  );
}

/**
 * Every template, the user's own above the built-in ones.
 *
 * App-wide, so the same list whatever project is open. Clicking a card hands it to `onUse`; the
 * view decides what "use" means for its kind, which for an automation is the editor, filled in.
 */
export function TemplatesPanel({
  projectId,
  projectPath,
  connection,
  onUse,
}: {
  projectId: number;
  projectPath: string;
  connection: ConnectionKey;
  onUse: (card: TemplateCard) => void;
}) {
  const { data: stored } = useTemplatesQuery();
  const { data: automations } = useAutomationsQuery(projectId);
  const save = useSaveTemplateMutation();
  const remove = useDeleteTemplateMutation();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Template | null>(null);
  const [deleting, setDeleting] = useState<Template | null>(null);

  const own = (stored ?? []).map(userCard);
  const searchable = own.length + BUILTIN_TEMPLATES.length > SEARCH_FROM;
  const shownOwn = searchCards(own, query);
  const shownBuiltin = searchCards(BUILTIN_TEMPLATES, query);

  const card = (item: TemplateCard) => (
    <Card
      key={item.key}
      card={item}
      onUse={() => onUse(item)}
      onEdit={() => item.stored && setEditing(item.stored)}
      onDelete={() => item.stored && setDeleting(item.stored)}
    />
  );

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col gap-6 overflow-y-auto rounded-t-xl border-x border-t border-border bg-background p-4">
      {searchable && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search templates…"
            aria-label="Search templates"
            className="h-8 pl-8 text-xs"
          />
        </div>
      )}

      <Section title="Yours" count={own.length}>
        {shownOwn.map(card)}
        {own.length === 0 && (
          <div className="col-span-full flex items-center gap-3 rounded-xl border border-dashed border-border p-4 text-xs text-muted-foreground">
            <LayoutTemplate className="size-4 shrink-0" />
            No templates of your own yet. To make one, open the ⋯ menu on an automation and choose
            Save as template.
          </div>
        )}
      </Section>

      {shownBuiltin.length > 0 && (
        <Section title="Built-in" count={BUILTIN_TEMPLATES.length}>
          {shownBuiltin.map(card)}
        </Section>
      )}

      {editing && (
        <AutomationEditorDialog
          open
          onOpenChange={(open) => !open && setEditing(null)}
          projectId={projectId}
          projectPath={projectPath}
          connection={connection}
          agents={[]}
          worktrees={[]}
          serverTimezone={automations?.server_timezone ?? localTimezone()}
          editing={asAutomation(editing)}
          template
          onSave={(automation) =>
            save.mutate({
              id: editing.id,
              name: automation.name,
              body: { kind: "automation", ...templateOf(automation) },
            })
          }
        />
      )}

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Automations already made from it are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleting) {
                  const name = deleting.name;
                  remove.mutate(deleting.id, {
                    onSuccess: () => toast.success(`Deleted “${name}”`),
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

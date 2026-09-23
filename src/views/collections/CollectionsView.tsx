import { useState } from "react";
import { ChevronDown, Cog, LayoutTemplate, Plus, type LucideIcon } from "lucide-react";
import { Button } from "@/ui/button";
import { ButtonGroup } from "@/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { AutomationsPanel } from "./automations/AutomationsPanel";
import { TemplatesPanel } from "./templates/TemplatesPanel";
import { automationFieldsOf, type TemplateCard, type TemplateKind } from "./templates/templates";
import type { Automation, ConnectionKey } from "@/types/bindings";

type Section = "automations" | "templates";

function NavItem({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-left",
        active ? "bg-accent/10 text-foreground" : "text-muted-foreground hover:bg-muted/50",
      )}
    >
      <Icon className={cn("size-3.5 shrink-0", active && "text-accent")} />
      <span className="truncate text-xs font-medium">{label}</span>
    </button>
  );
}

/**
 * The project's reusable pieces. Automations today, with skills and MCP servers meant to land
 * beside them; Templates sits apart at the bottom because it holds starting points for every one
 * of those kinds rather than being one of them.
 *
 * Same shape as the other views: `bg-card` all the way up, an action bar across the top carrying
 * the section's primary action, and the content inset behind a rounded top-left corner so the bar
 * and the sidebar read as one surface. The editor's open state is held here rather than in the
 * panel because the buttons that open it live in that bar and on the template cards.
 */
export function CollectionsView({
  projectId,
  projectPath,
  connection,
}: {
  projectId: number;
  projectPath: string;
  connection: ConnectionKey;
}) {
  const [section, setSection] = useState<Section>("automations");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Automation | null>(null);
  const [seed, setSeed] = useState<Partial<Automation> | null>(null);
  // Templates is reached filtered from "New automation" and unfiltered from the sidebar.
  const [templateKind, setTemplateKind] = useState<TemplateKind | null>(null);

  function openEditor(automation: Automation | null) {
    setEditing(automation);
    setSeed(null);
    setEditorOpen(true);
  }

  // A template is used over the Automations page, so the new automation is in view once saved.
  function startFromTemplate(card: TemplateCard) {
    setSection("automations");
    setEditing(null);
    setSeed(automationFieldsOf(card.name, card.body));
    setEditorOpen(true);
  }

  return (
    <div className="flex h-full flex-col bg-card">
      {/* No bottom border: the inset pane's own `border-t` is the seam, and it starts after the
          rounded corner so no line runs under the sidebar. */}
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 px-4">
        <span className="text-sm font-medium">
          {section === "automations" ? "Automations" : "Templates"}
        </span>
        {section === "automations" && (
          <ButtonGroup>
            <Button
              variant="accent"
              size="sm"
              className="h-8 bg-clip-border text-xs"
              onClick={() => openEditor(null)}
            >
              <Plus className="mr-1 size-3.5" />
              New automation
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="New automation from a template"
                render={
                  <Button variant="accent" size="sm" className="h-8 bg-clip-border px-1.5!" />
                }
              >
                <ChevronDown className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-auto max-w-80 whitespace-nowrap">
                <DropdownMenuItem
                  className="text-xs"
                  onClick={() => {
                    setTemplateKind("automation");
                    setSection("templates");
                  }}
                >
                  <LayoutTemplate className="size-3.5 text-muted-foreground" />
                  From templates
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </ButtonGroup>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <nav className="flex w-56 shrink-0 flex-col gap-0.5 px-2 pb-3">
          <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
            Collections
          </p>
          <NavItem
            icon={Cog}
            label="Automations"
            active={section === "automations"}
            onClick={() => setSection("automations")}
          />
          <div className="mx-2 my-2 border-t border-border" />
          <NavItem
            icon={LayoutTemplate}
            label="Templates"
            active={section === "templates"}
            onClick={() => {
              setTemplateKind(null);
              setSection("templates");
            }}
          />
        </nav>

        {/* The inset surface is the panel's own, not this one's: it rounds away from the runs
            column when that is open, which this cannot know. Same shape as Worktrees. */}
        <div className="flex min-h-0 flex-1 overflow-hidden bg-card">
          {section === "automations" ? (
            <AutomationsPanel
              projectId={projectId}
              projectPath={projectPath}
              connection={connection}
              editorOpen={editorOpen}
              onEditorOpenChange={setEditorOpen}
              editing={editing}
              seed={seed}
              onEdit={openEditor}
            />
          ) : (
            <TemplatesPanel
              projectId={projectId}
              projectPath={projectPath}
              connection={connection}
              kind={templateKind}
              onKindChange={setTemplateKind}
              onUse={startFromTemplate}
            />
          )}
        </div>
      </div>
    </div>
  );
}

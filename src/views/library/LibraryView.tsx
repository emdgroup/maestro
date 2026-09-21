import { useState } from "react";
import { Bot, Plus } from "lucide-react";
import { Button } from "@/ui/button";
import { AutomationsPanel } from "./automations/AutomationsPanel";
import type { Automation, ConnectionKey } from "@/types/bindings";

/**
 * The project's reusable pieces. Automations today; skills and MCP servers are meant to land
 * beside them, which is why this is a sidebar with one entry rather than a bare page — adding the
 * next section is a row here and a component, not a rework of the view.
 *
 * Same shape as the other views: `bg-card` all the way up, an action bar across the top carrying
 * the section's primary action, and the content inset behind a rounded top-left corner so the bar
 * and the sidebar read as one surface. The editor's open state is held here rather than in the
 * panel because the button that opens it lives in that bar.
 */
export function LibraryView({
  projectId,
  projectPath,
  connection,
}: {
  projectId: number;
  projectPath: string;
  connection: ConnectionKey;
}) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Automation | null>(null);

  function openEditor(automation: Automation | null) {
    setEditing(automation);
    setEditorOpen(true);
  }

  return (
    <div className="flex h-full flex-col bg-card">
      {/* No bottom border: the inset pane's own `border-t` is the seam, and it starts after the
          rounded corner so no line runs under the sidebar. */}
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 px-4">
        <span className="text-sm font-medium">Automations</span>
        <Button
          variant="accent"
          size="sm"
          className="h-8 bg-clip-border text-xs"
          onClick={() => openEditor(null)}
        >
          <Plus className="mr-1 size-3.5" />
          New automation
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        <nav className="flex w-56 shrink-0 flex-col px-2 pb-3">
          <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
            Library
          </p>
          <div
            aria-current="page"
            className="flex items-center gap-2 rounded-md bg-accent/10 px-2 py-1.5 text-foreground"
          >
            <Bot className="size-3.5 shrink-0 text-accent" />
            <span className="truncate text-xs font-medium">Automations</span>
          </div>
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-tl-xl border-l border-t border-border bg-background">
          <AutomationsPanel
            projectId={projectId}
            projectPath={projectPath}
            connection={connection}
            editorOpen={editorOpen}
            onEditorOpenChange={setEditorOpen}
            editing={editing}
            onEdit={openEditor}
          />
        </div>
      </div>
    </div>
  );
}

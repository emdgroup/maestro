import { useState } from "react";
import { X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { MarkdownEditor } from "@/components/kanban/shared/MarkdownEditor";
import { cn } from "@/lib/utils";
import { useSaveSkillMutation, type SkillAgents } from "@/services/skill.service";
import { AgentStack, AgentsMenu, agentFor } from "../AgentsMenu";
import { isSkillName } from "./skills";
import type { ConnectionKey, DiscoveredAgent, SkillInfo } from "@/types/bindings";

/**
 * Writes a skill of the user's own, or edits `editing`. The name is fixed once saved: it is the
 * directory every agent has the skill under.
 */
export function SkillEditorDialog({
  open,
  onOpenChange,
  connection,
  agents,
  supported,
  editing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection: ConnectionKey;
  agents: DiscoveredAgent[];
  supported: string[];
  editing: SkillInfo | null;
}) {
  const save = useSaveSkillMutation(connection);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [deployed, setDeployed] = useState<SkillAgents>({});

  const [shownFor, setShownFor] = useState<string | null>(null);
  const current = open ? (editing?.name ?? "new") : null;
  if (shownFor !== current) {
    setShownFor(current);
    if (open) {
      setName(editing?.name ?? "");
      setDescription(editing?.description ?? "");
      setInstructions(editing?.instructions ?? "");
      setDeployed(editing?.agents ?? {});
    }
  }

  const on = Object.keys(deployed).filter((id) => deployed[id]);
  const nameValid = isSkillName(name);
  const valid = nameValid && description.trim() !== "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
      >
        <div className="flex items-center gap-2 border-b border-border px-5 py-2.5">
          <DialogTitle className="text-[11px] font-medium text-muted-foreground">
            {editing ? "Edit skill" : "New skill"}
          </DialogTitle>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close"
            className="ml-auto text-muted-foreground"
            onClick={() => onOpenChange(false)}
          >
            <X className="size-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 pb-5 pt-5">
          <Input
            autoFocus={!editing}
            aria-label="Name"
            value={name}
            disabled={editing !== null}
            onChange={(event) => setName(event.target.value)}
            placeholder="my-skill"
            className={cn(
              "h-8 font-mono text-xs",
              name !== "" && !nameValid && "border-destructive",
            )}
          />
          {name !== "" && !nameValid && (
            <p className="text-[11px] text-destructive">
              Lowercase letters, digits and hyphens, up to 64.
            </p>
          )}
          <Input
            aria-label="Description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="When an agent should use this skill, in one sentence"
            className="h-8 text-xs"
          />
          <div className="h-72">
            <MarkdownEditor
              value={instructions}
              onSave={setInstructions}
              onDraftChange={setInstructions}
              isEditable
              fill
              placeholder="Instructions the agent follows once it uses the skill…"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[11px] text-muted-foreground">Agents</span>
            <AgentStack agents={on.map((id) => agentFor(agents, id))} empty="None yet" />
            <AgentsMenu
              agents={agents}
              supported={supported}
              selected={on}
              label={on.length ? "Change" : "Choose agents"}
              onSelectAll={() =>
                setDeployed({
                  ...deployed,
                  ...Object.fromEntries(
                    agents
                      .filter((agent) => supported.includes(agent.id))
                      .map((agent) => [agent.id, true]),
                  ),
                })
              }
              onToggle={(id, enabled) => {
                const next = { ...deployed };
                if (enabled) next[id] = true;
                // A new skill forgets an agent outright; a saved one keeps it switched off.
                else if (editing?.agents[id] !== undefined) next[id] = false;
                else delete next[id];
                setDeployed(next);
              }}
            />
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-border bg-muted/30 px-5 py-3">
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
            Installed globally for each agent on this connection.
          </span>
          <Button variant="ghost" className="ml-auto" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="accent"
            disabled={!valid || save.isPending}
            onClick={() =>
              save.mutate(
                { name, description, instructions, agents: deployed },
                { onSuccess: () => onOpenChange(false) },
              )
            }
          >
            {save.isPending ? "Installing…" : editing ? "Save" : "Create skill"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

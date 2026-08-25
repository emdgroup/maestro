import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/ui/dialog";
import { Button, buttonVariants } from "@/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/ui/select";
import { useAgentProfilesQuery } from "@/services/project.service";
import { useSetTaskProfileOverridesMutation } from "@/services/task.service";
import type { AgentRole, Task } from "@/types/bindings";

/// The roles in the order a task passes through them, with the label the board uses for the stage
/// rather than the role's own name.
const ROLES: Array<{ role: AgentRole; label: string }> = [
  { role: "Refiner", label: "Refinement" },
  { role: "Planner", label: "Planning" },
  { role: "Coder", label: "Implementation" },
  { role: "Reviewer", label: "Review" },
];

const USE_PROJECT_DEFAULT = "";

/// Which agent profile this one task should use for each stage.
///
/// Profiles, not settings. A task picks between the profiles the project has defined rather than
/// describing an agent of its own, so it cannot ask for a combination nobody configured — and a
/// profile deleted afterwards falls back to the project default rather than breaking the task.
/// That is `ProfilesDocument::resolve`'s existing behaviour, which already takes an override id.
///
/// Only reachable from a Planning card, because this is a decision to make *before* the work
/// starts: a role that has already run does not re-run because its profile changed.
export function TaskProfilesDialog({
  task,
  projectId,
  open,
  onOpenChange,
}: {
  task: Task;
  projectId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: document } = useAgentProfilesQuery(open ? projectId : null);
  const setOverrides = useSetTaskProfileOverridesMutation();

  const stored: Record<string, string> = task.profile_overrides
    ? (JSON.parse(task.profile_overrides) as Record<string, string>)
    : {};

  const [choices, setChoices] = useState<Record<string, string>>(stored);

  // Reopening shows what is stored rather than what was abandoned last time. Adjusted during
  // render rather than from an effect, which would paint one frame of the previous edit.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) setChoices(stored);
  }

  const profiles = document?.profiles ?? [];
  const defaults = document?.defaults ?? {};

  function save() {
    onOpenChange(false);
    setOverrides.mutate({
      taskId: task.id,
      // Empty strings are "use the project default", which is an absence rather than a choice.
      overrides: Object.fromEntries(Object.entries(choices).filter(([, id]) => id !== "")),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SlidersHorizontal className="size-4 text-accent" />
            Agents for “{task.title}”
          </DialogTitle>
          <DialogDescription>
            Overrides this project&apos;s defaults for this task only. Set them before it starts — a
            stage that has already run does not run again.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {ROLES.map(({ role, label }) => {
            const forRole = profiles.filter((p) => p.role === role);
            const defaultName =
              forRole.find((p) => p.id === defaults[role])?.name ?? forRole[0]?.name;
            const chosen = choices[role] ?? USE_PROJECT_DEFAULT;
            const fallbackLabel =
              forRole.length === 0
                ? "No profile — stage skipped"
                : `Project default${defaultName ? ` (${defaultName})` : ""}`;

            return (
              <div key={role} className="text-xs space-y-1">
                <span className="font-medium">{label}</span>
                <Select
                  value={chosen}
                  disabled={forRole.length === 0}
                  // `?? ""` because base-ui hands back null when a selection is cleared, and ""
                  // is already this dialog's word for "use the project default".
                  onValueChange={(v) => setChoices((prev) => ({ ...prev, [role]: v ?? "" }))}
                >
                  <SelectTrigger size="sm" className="w-full text-xs" aria-label={label}>
                    <span className="truncate flex-1 text-left">
                      {forRole.find((p) => p.id === chosen)?.name ?? fallbackLabel}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={USE_PROJECT_DEFAULT} className="text-xs">
                      {fallbackLabel}
                    </SelectItem>
                    {forRole.map((profile) => (
                      <SelectItem key={profile.id} value={profile.id} className="text-xs">
                        {profile.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          })}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className={buttonVariants({ variant: "accent" })} onClick={save}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

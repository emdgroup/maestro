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
import { parseProfileOverrides, type ProfileOverrides } from "@/lib/profile-overrides";
import type { AgentRole, Task } from "@/types/bindings";

/**
 * The roles in the order a task passes through them, with the label the board uses for the stage
 * rather than the role's own name.
 *
 * `optional` is which stages a task may decline, and only the two the pipeline starts on its own
 * qualify. Implementation is excluded because a task that runs no coder does nothing. Refinement
 * is excluded for the opposite reason: nothing ever hands work to it — the user presses Refine —
 * so declining it here would only disable a button they need not press.
 */
const ROLES: Array<{ role: AgentRole; label: string; optional: boolean }> = [
  { role: "Refiner", label: "Refinement", optional: false },
  { role: "Planner", label: "Planning", optional: true },
  { role: "Coder", label: "Implementation", optional: false },
  { role: "Reviewer", label: "Review", optional: true },
];

const USE_PROJECT_DEFAULT = "";

/**
 * The select's value for "skip", which is `null` everywhere outside this component.
 *
 * A select option cannot carry null — base-ui hands null back for a cleared selection, which is
 * already what `USE_PROJECT_DEFAULT` means — so the two states need two values here. The sentinel
 * never leaves the dialog: `save` maps it back to `null` before the write.
 */
const SKIP_STAGE = "__maestro_skip_stage__";

/**
 * Which agent profile this one task should use for each stage.
 *
 * Profiles, not settings. A task picks between the profiles the project has defined rather than
 * describing an agent of its own, so it cannot ask for a combination nobody configured — and a
 * profile deleted afterwards falls back to the project default rather than breaking the task.
 * That is `ProfilesDocument::resolve`'s existing behaviour, which already takes an override id.
 *
 * Only reachable from a Planning card, because this is a decision to make *before* the work
 * starts: a role that has already run does not re-run because its profile changed.
 */
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

  const stored = parseProfileOverrides(task.profile_overrides);

  // Values are a profile id, `USE_PROJECT_DEFAULT`, or `null` for a skipped stage — the same three
  // states the stored map has, so what is edited here is what is written back.
  const [choices, setChoices] = useState<ProfileOverrides>(stored);

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
      // Empty strings are "use the project default", which is an absence rather than a choice, so
      // they are dropped. `null` is a choice — "skip this stage" — and has to survive the filter,
      // which is why this tests for the marker rather than for falsiness.
      overrides: Object.fromEntries(
        Object.entries(choices).filter(([, id]) => id !== USE_PROJECT_DEFAULT),
      ),
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
            Overrides the agent each role uses, for this task only. Roles are configured in
            Settings.
          </DialogDescription>
        </DialogHeader>

        {/* Four disabled selects all reading "No profile (stage skipped)" is a dialog that looks
            broken rather than one saying there is nothing to choose between yet. */}
        {profiles.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            This project has no agent profiles yet, so there is nothing to override here. Add one
            per role in Settings.
          </p>
        ) : (
          <div className="space-y-3">
            {ROLES.map(({ role, label, optional }) => {
              const forRole = profiles.filter((p) => p.role === role);
              const defaultName =
                forRole.find((p) => p.id === defaults[role])?.name ?? forRole[0]?.name;
              // `=== null` rather than a falsy test: an absent key is "the project decides" and a
              // null one is "skip", and the select needs a different value for each.
              const choice = choices[role];
              const chosen = choice === null ? SKIP_STAGE : (choice ?? USE_PROJECT_DEFAULT);
              const fallbackLabel =
                forRole.length === 0
                  ? "No profile (stage skipped)"
                  : `Project default${defaultName ? ` (${defaultName})` : ""}`;
              // A role the project has no profile for is already skipped, so there is nothing to
              // choose: the select stays disabled and says so, as it did before skipping existed.
              const canSkip = optional && forRole.length > 0;

              return (
                <div key={role} className="text-xs space-y-1">
                  <span className="font-medium">{label}</span>
                  <Select
                    value={chosen}
                    disabled={forRole.length === 0}
                    // `?? ""` because base-ui hands back null when a selection is cleared, and ""
                    // is already this dialog's word for "use the project default".
                    onValueChange={(v) =>
                      setChoices((prev) => ({
                        ...prev,
                        [role]: v === SKIP_STAGE ? null : (v ?? USE_PROJECT_DEFAULT),
                      }))
                    }
                  >
                    <SelectTrigger size="sm" className="w-full text-xs" aria-label={label}>
                      <span className="truncate flex-1 text-left">
                        {chosen === SKIP_STAGE
                          ? "Skip this stage"
                          : (forRole.find((p) => p.id === chosen)?.name ?? fallbackLabel)}
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
                      {canSkip && (
                        <SelectItem value={SKIP_STAGE} className="text-xs">
                          Skip this stage
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>
              );
            })}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {profiles.length === 0 ? "Close" : "Cancel"}
          </Button>
          {profiles.length > 0 && (
            <Button className={buttonVariants({ variant: "accent" })} onClick={save}>
              Save
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

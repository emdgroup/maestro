import { useState } from "react";
import { X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
import { MarkdownEditor } from "@/components/kanban/shared/MarkdownEditor";
import { cn } from "@/lib/utils";
import { useSaveSkillMutation } from "@/services/skill.service";
import { ALL_AGENTS, Segmented } from "../AgentsDialog";
import {
  isSkillName,
  parseSkillMd,
  renderSkillMd,
  skillNameProblems,
  splitTools,
  toSkillName,
  type SkillForm,
  type SkillInvocation,
} from "./skills";
import { ToolsInput } from "./ToolsInput";
import type { ConnectionKey, SkillInfo } from "@/types/bindings";

/** The Agent Skills spec limit, which `save_skill` enforces too. */
const MAX_DESCRIPTION = 1024;

const BLANK: SkillForm = {
  name: "",
  description: "",
  invocation: "anyone",
  argumentHint: "",
  allowedTools: "",
  instructions: "",
  extra: "",
};

const INVOCATIONS: { value: SkillInvocation; label: string; hint: string }[] = [
  {
    value: "anyone",
    label: "Both",
    hint: "When the description fits, or as a /command.",
  },
  { value: "user_only", label: "Only you", hint: "Only when you type its /command." },
  { value: "agent_only", label: "Only the agent", hint: "When the description fits. No /command." },
];

/**
 * Writes a skill of the user's own, or edits `editing`. The name is fixed once saved: it is the
 * directory every agent has the skill under. A new skill goes to every agent;
 * the card changes that. The Markdown view edits the whole `SKILL.md`; frontmatter the form has no
 * field for rides along in `SkillForm.extra`, so switching views keeps it.
 */
export function SkillEditorDialog({
  open,
  onOpenChange,
  connection,
  editing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection: ConnectionKey;
  editing: SkillInfo | null;
}) {
  const save = useSaveSkillMutation(connection);
  const [form, setForm] = useState<SkillForm>(BLANK);
  // What was last typed, before `toSkillName` cleaned it: which rules it broke is what to show.
  const [typedName, setTypedName] = useState("");
  const [raw, setRaw] = useState<{ text: string } | null>(null);

  const [shownFor, setShownFor] = useState<string | null>(null);
  const current = open ? (editing?.name ?? "new") : null;
  if (shownFor !== current) {
    setShownFor(current);
    if (open) {
      setForm(editing ? parseSkillMd(editing.skill_md) : BLANK);
      setTypedName("");
      setRaw(null);
    }
  }

  const skill = raw ? parseSkillMd(raw.text) : form;
  const issue = !isSkillName(skill.name)
    ? "SKILL.md needs a valid name"
    : editing && skill.name !== editing.name
      ? `The name has to stay ${editing.name}`
      : !skill.description.trim()
        ? "SKILL.md needs a description"
        : skill.description.trim().length > MAX_DESCRIPTION
          ? `The description is over ${MAX_DESCRIPTION} characters`
          : null;
  const problems = skillNameProblems(typedName);
  const invocation = INVOCATIONS.find((option) => option.value === form.invocation);
  const agentOnly = form.invocation === "agent_only";
  const set = (patch: Partial<SkillForm>) => setForm({ ...form, ...patch });
  const switchView = (view: string) => {
    if (view === "markdown" && !raw) setRaw({ text: renderSkillMd(form) });
    if (view === "form" && raw) {
      const parsed = parseSkillMd(raw.text);
      // The name of a saved skill is its directory, which the Markdown cannot rename.
      setForm(editing ? { ...parsed, name: editing.name } : parsed);
      setTypedName(editing ? "" : parsed.name);
      setRaw(null);
    }
  };
  const submit = () =>
    save.mutate(
      {
        name: skill.name,
        skillMd: raw ? raw.text : renderSkillMd(form),
        agents: editing ? editing.agents : { [ALL_AGENTS]: true },
      },
      { onSuccess: () => onOpenChange(false) },
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
      >
        <div className="flex items-center gap-2 border-b border-border px-5 py-2.5">
          <DialogTitle className="text-[11px] font-medium text-muted-foreground">
            {editing ? "Edit skill" : "New skill"}
          </DialogTitle>
          <Segmented
            label="View"
            className="ml-auto"
            size="xs"
            value={raw ? "markdown" : "form"}
            options={[
              { value: "form", label: "Form" },
              { value: "markdown", label: "Markdown" },
            ]}
            onChange={switchView}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close"
            className="text-muted-foreground"
            onClick={() => onOpenChange(false)}
          >
            <X className="size-4" />
          </Button>
        </div>

        {raw ? (
          <div className="flex min-h-0 flex-1 flex-col px-6 py-5">
            <Textarea
              autoFocus
              aria-label="SKILL.md"
              value={raw.text}
              spellCheck={false}
              rows={24}
              onChange={(event) => setRaw({ text: event.target.value })}
              className="min-h-0 flex-1 resize-none font-mono text-xs"
            />
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
            <Field label="Name">
              <Input
                autoFocus={!editing}
                aria-label="Name"
                aria-invalid={problems.length > 0}
                value={form.name}
                disabled={editing !== null}
                onChange={(event) => {
                  setTypedName(event.target.value);
                  set({ name: toSkillName(event.target.value) });
                }}
                placeholder="my-skill"
                className={cn("h-8 font-mono text-xs", problems.length > 0 && "border-destructive")}
              />
              {problems.length > 0 && (
                <p className="text-[11px] text-destructive">{problems.join(" · ")}</p>
              )}
            </Field>

            <Field label="Description" aside={`${form.description.length} / ${MAX_DESCRIPTION}`}>
              <Textarea
                aria-label="Description"
                value={form.description}
                maxLength={MAX_DESCRIPTION}
                rows={3}
                onChange={(event) => set({ description: event.target.value })}
                placeholder="What the skill does and when to use it. Name the tasks, files and words that should bring it up."
                className="text-xs"
              />
            </Field>

            <div className="grid grid-cols-[auto_1fr] gap-3">
              <Field label="Who can use it">
                <Segmented
                  label="Who can use it"
                  value={form.invocation}
                  options={INVOCATIONS}
                  onChange={(value) => set({ invocation: value as SkillInvocation })}
                />
                <p className="whitespace-nowrap text-[11px] text-muted-foreground">
                  {invocation?.hint}
                </p>
              </Field>
              <Field label="Argument hint">
                <Input
                  aria-label="Argument hint"
                  value={agentOnly ? "" : form.argumentHint}
                  disabled={agentOnly}
                  onChange={(event) => set({ argumentHint: event.target.value })}
                  placeholder={agentOnly ? "No /command" : "What to type after the /command"}
                  className="h-8 font-mono text-xs"
                />
              </Field>
            </div>

            <Field label="Allowed tools">
              <ToolsInput
                tools={splitTools(form.allowedTools)}
                onChange={(tools) => set({ allowedTools: tools.join(" ") })}
              />
            </Field>

            <Field label="Instructions">
              <div className="h-72">
                <MarkdownEditor
                  value={form.instructions}
                  onSave={(instructions) => set({ instructions })}
                  onDraftChange={(instructions) => set({ instructions })}
                  isEditable
                  fill
                  placeholder="Define this skill's instructions and how agents should use it…"
                />
              </div>
            </Field>
          </div>
        )}

        <div className="flex items-center gap-2 border-t border-border bg-muted/30 px-5 py-3">
          <span
            className={cn(
              "min-w-0 truncate text-[11px] text-muted-foreground",
              raw && issue && "text-destructive",
            )}
          >
            {(raw && issue) || "For every project on this connection."}
          </span>
          <Button variant="ghost" className="ml-auto" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="accent" disabled={issue !== null || save.isPending} onClick={submit}>
            {save.isPending ? "Saving…" : editing ? "Save" : "Create"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  aside,
  children,
}: {
  label: string;
  aside?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-2">
        <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
        {aside && (
          <span className="ml-auto text-[10px] tabular-nums text-muted-foreground/70">{aside}</span>
        )}
      </div>
      {children}
    </div>
  );
}

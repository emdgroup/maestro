import { useState } from "react";
import { BookOpen, Lock, Pencil, Play, Plus, Sparkles, StickyNote, Undo2, X } from "lucide-react";
import type { LoopCheck, LoopCheckKind, Task, TaskComment } from "@/types/bindings";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/ui/select";
import { cn } from "@/lib/utils";
import { MarkdownBlock } from "@/components/execution/activity/MarkdownBlock";
import { useTaskCommentsQuery } from "@/services/task.service";
import {
  useAddLoopNoteMutation,
  useAnswerLoopProposalMutation,
  useLoopChecksQuery,
  useLoopIterationsQuery,
  useRerunLoopChecksMutation,
  useResumeLoopMutation,
  usePauseLoopMutation,
  useTickLoopCheckMutation,
} from "@/services/loop.service";
import { useTaskSession } from "@/contexts/BoardActionsContext";
import { useSessionActivity } from "@/store/sessionActivityStore";
import {
  CHECK_KINDS,
  CheckEditor,
  ChecksRunCard,
  HiddenCard,
  KIND_HELP,
  LimitCards,
  usePrefillHidden,
} from "./LoopEditor";
import { LoopIterations, type CurrentState, type Head } from "./LoopIterations";
import { blankCheck, doneWhenRows, type CheckDraft, type LoopDraft } from "./loop-draft";
import { gateLine, loopHalt } from "./loop-state";

/** Accepting a proposal makes it a full check, of the kind the user picks, sealing what it names. */
function AcceptForm({
  check,
  onAccept,
  onCancel,
}: {
  check: LoopCheck;
  onAccept: (kind: LoopCheckKind, label: string, command: string, seal: string[]) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<LoopCheckKind>(check.kind);
  const [label, setLabel] = useState(check.label);
  const [command, setCommand] = useState(check.command ?? "");
  const [seal, setSeal] = useState("");
  return (
    <div className="mt-2 space-y-1.5">
      <div className="grid grid-cols-[8rem_1fr] gap-1.5">
        <Select value={kind} onValueChange={(v) => v && setKind(v as LoopCheckKind)}>
          <SelectTrigger size="sm" className="w-full text-xs" aria-label="Kind">
            <span className="truncate flex-1 text-left">{CHECK_KINDS[kind].name}</span>
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(CHECK_KINDS) as LoopCheckKind[]).map((k) => (
              <SelectItem key={k} value={k} className="text-xs">
                {CHECK_KINDS[k].name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input value={label} onChange={(e) => setLabel(e.target.value)} className="h-8 text-xs" />
      </div>
      {kind === "Command" && (
        <Input
          value={command}
          placeholder="The command to run, for example bun run test"
          onChange={(e) => setCommand(e.target.value)}
          className="h-8 font-mono text-xs"
        />
      )}
      <Input
        value={seal}
        placeholder="Files to hide from the agent, comma separated (they must be on the base branch)"
        onChange={(e) => setSeal(e.target.value)}
        className="h-8 font-mono text-xs"
      />
      <div className="flex justify-end gap-1.5">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!label.trim() || (kind === "Command" && !command.trim())}
          onClick={() =>
            onAccept(
              kind,
              label.trim(),
              command.trim(),
              seal
                .split(",")
                .map((p) => p.trim())
                .filter(Boolean),
            )
          }
        >
          Accept
        </Button>
      </div>
    </div>
  );
}

/** A proposal from the worker: its reason, and its command only as a suggestion. */
function ProposalRow({ task, check }: { task: Task; check: LoopCheck }) {
  const answer = useAnswerLoopProposalMutation();
  const [accepting, setAccepting] = useState(false);
  const key = { projectId: task.project_id, taskId: task.id };
  return (
    <li className="bg-accent/8 px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-sm">{check.label}</div>
          <div className="mt-0.5 line-clamp-3 text-xs text-muted-foreground">
            {check.detail}
            {check.command && (
              <span className="font-mono">
                {check.detail ? " · " : ""}
                {check.command}
              </span>
            )}
          </div>
        </div>
        <span className="flex shrink-0 items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 text-xs text-muted-foreground">
          <Sparkles className="size-3" />
          Proposed
        </span>
        {!accepting && (
          <span className="flex shrink-0 gap-2 text-xs">
            <button className="text-accent hover:underline" onClick={() => setAccepting(true)}>
              Accept
            </button>
            <button
              className="text-muted-foreground hover:underline"
              onClick={() => answer.mutate({ ...key, checkId: check.id, accept: null, seal: [] })}
            >
              Reject
            </button>
          </span>
        )}
      </div>
      {accepting && (
        <AcceptForm
          check={check}
          onCancel={() => setAccepting(false)}
          onAccept={(kind, label, command, seal) => {
            setAccepting(false);
            answer.mutate({
              ...key,
              checkId: check.id,
              accept: { kind, label, command: kind === "Command" ? command : null },
              seal,
            });
          }}
        />
      )}
    </li>
  );
}

/** One of the user's checks, as edited. The list is for editing only, so it carries no result. */
function CheckRow({
  draft,
  readOnly,
  onEdit,
  onRemove,
}: {
  draft: CheckDraft;
  readOnly: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { icon: KindIcon, name } = CHECK_KINDS[draft.kind];
  return (
    <li className="group px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-sm">{draft.label}</div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {draft.kind === "Command" ? (
              <span className="font-mono">{draft.command}</span>
            ) : (
              KIND_HELP[draft.kind]
            )}
          </div>
        </div>
        <span className="flex shrink-0 items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 text-xs text-muted-foreground">
          <KindIcon className="size-3" />
          {name}
        </span>
        {!readOnly && (
          <span className="flex shrink-0 gap-0.5 text-muted-foreground opacity-50 group-hover:opacity-100">
            <button
              type="button"
              aria-label={`Edit "${draft.label}"`}
              className="rounded p-1 hover:bg-muted hover:text-foreground"
              onClick={onEdit}
            >
              <Pencil className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label={`Remove "${draft.label}"`}
              className="rounded p-1 hover:bg-muted hover:text-foreground"
              onClick={onRemove}
            >
              <X className="size-3.5" />
            </button>
          </span>
        )}
      </div>
    </li>
  );
}

/** The newest entry of a kind. */
const latest = (comments: TaskComment[], kind: string) =>
  [...comments].reverse().find((c) => c.kind === kind);

/** The row being edited, with what it held when editing began; `null` for a row just added. */
type Editing = { key: string; before: CheckDraft | null };

type View = "iterations" | "settings";

/**
 * A loop on one tab. Before it starts, its settings: the checks it is done when, its limits, what
 * runs around the checks and what is hidden from the agent. Once started, the iterations come
 * first, as a timeline headed by the one running, with the note for the next iteration above
 * them; the settings are a switch away. Edits go into the draft, saved with the rest of the task.
 */
export function LoopTab({
  task,
  draft,
  onDraftChange,
  baseBranch,
  sealedLocked,
  readOnly,
  onJoin,
  onPrepare,
}: {
  task: Task;
  draft: LoopDraft;
  onDraftChange: (draft: LoopDraft) => void;
  baseBranch: string;
  sealedLocked: boolean;
  readOnly: boolean;
  onJoin: () => void;
  /** Starts Prepare loop, where it can be. */
  onPrepare: (() => void) | null;
}) {
  const key = { projectId: task.project_id, taskId: task.id };
  const { data: checks = [] } = useLoopChecksQuery(task.project_id, task.id);
  const { data: iterations = [] } = useLoopIterationsQuery(task.project_id, task.id);
  const { data: comments = [] } = useTaskCommentsQuery(task.project_id, task.id);
  const rerun = useRerunLoopChecksMutation();
  const resume = useResumeLoopMutation();
  const pause = usePauseLoopMutation();
  const addNote = useAddLoopNoteMutation();
  const tick = useTickLoopCheckMutation();
  const session = useTaskSession(task.id);
  const activity = useSessionActivity(session?.session_id);
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [view, setView] = useState<View>("iterations");

  const set = (patch: Partial<LoopDraft>) => onDraftChange({ ...draft, ...patch });
  const setCheck = (rowKey: string, patch: Partial<CheckDraft>) =>
    set({ checks: draft.checks.map((c) => (c.key === rowKey ? { ...c, ...patch } : c)) });
  const removeCheck = (rowKey: string) =>
    set({ checks: draft.checks.filter((c) => c.key !== rowKey) });
  const addCheck = (kind: LoopCheckKind) => {
    const check = blankCheck(kind);
    set({ checks: [...draft.checks, check] });
    setEditing({ key: check.key, before: null });
  };
  const editCheck = (check: CheckDraft) => setEditing({ key: check.key, before: check });
  const cancelEdit = () => {
    if (!editing) return;
    if (editing.before) setCheck(editing.key, editing.before);
    else removeCheck(editing.key);
    setEditing(null);
  };
  const prefill = usePrefillHidden(
    draft,
    onDraftChange,
    task.project_id,
    baseBranch,
    sealedLocked || readOnly,
  );

  const config = task.loop_config ?? null;
  const summary = task.loop_summary ?? null;
  const halt = loopHalt(task);
  const gate = gateLine(task);
  const signoff = task.phase === "Approval";
  const live = task.phase_status === "Running" || task.phase_status === "Blocked";
  const started = (summary?.iteration ?? 0) > 0;
  // A Build reads the list when it starts and the checks when they run, so the list holds still
  // while either works. Pause lets the iteration end cleanly, and the lock lifts then.
  const checksLocked = !readOnly && (live || task.phase === "Checking");
  const checksReadOnly = readOnly || checksLocked;
  const rows = doneWhenRows(draft.checks, checks);
  const real = checks.filter((c) => !c.proposed || c.accepted);
  const proposals = rows.filter((r) => r.kind === "proposal").length;
  // The digest describes the work that reached sign-off; while the loop works again it is stale.
  const reviewing = signoff || task.phase === "AwaitingMerge" || task.status === "Done";
  const digest = reviewing ? latest(comments, "digest") : undefined;
  const lastStart = iterations[iterations.length - 1]?.started_at;
  const pendingNotes = comments.filter(
    (c) => c.kind === "steer" && (!lastStart || c.created_at > lastStart),
  );
  const flaky = real.filter((c) => c.state === "Flaky");
  const editFlaky = () => {
    const row = draft.checks.find((c) => flaky.some((f) => f.id === c.id));
    setView("settings");
    if (row) editCheck(row);
  };

  // What heads the timeline: the iteration at work, or the one the loop stopped after and why.
  const last = iterations[iterations.length - 1];
  const steps: Partial<Record<string, 0 | 1 | 2>> = { Iterating: 0, Checking: 1, Judging: 2 };
  const step = steps[task.phase ?? ""];
  const blocked = halt === "Blocked" && last?.outcome === "Blocked";
  const head: Head | null = blocked
    ? { kind: "blocked" }
    : live && step !== undefined
      ? {
          kind: "live",
          step,
          activity:
            activity && step === 0
              ? { status: activity.status, since: activity.stateChangedAt }
              : null,
        }
      : gate && task.gate
        ? {
            kind: "gated",
            label: gate.label,
            agentId: task.gate.agent_id,
            resumeAt: task.gate.resume_at,
            backoff: task.gate.backoff,
          }
        : halt && halt !== "Blocked"
          ? { kind: "halted", halt }
          : signoff
            ? { kind: "signoff" }
            : task.phase === "AwaitingMerge"
              ? { kind: "merge" }
              : null;
  const current: CurrentState | null = last && head ? { iteration: last, head } : null;

  // The note goes into the next iteration; on a loop that waits on the user it is also the answer
  // that lets it go on. A `loop_blocked` question is answered in its own card instead.
  const resumes = (!!halt && !blocked) || signoff;
  const takesNote =
    live || resumes || blocked || (task.phase_status === "Waiting" && task.ball === "Agent");
  const segment = (id: View, label: string, badge?: number) => (
    <button
      type="button"
      aria-pressed={view === id}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-md px-3 text-xs",
        view === id ? "bg-background font-medium shadow-sm" : "text-muted-foreground",
      )}
      onClick={() => setView(id)}
    >
      {label}
      {!!badge && (
        <span className="rounded-full bg-accent px-1.5 text-[10px] font-semibold text-accent-foreground">
          {badge}
        </span>
      )}
    </button>
  );
  const topRow = (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <div className="inline-flex shrink-0 rounded-lg bg-muted p-0.5">
          {segment("iterations", "Iterations")}
          {segment("settings", "Checks & settings", proposals)}
        </div>
        {takesNote &&
          (blocked ? (
            <span className="flex-1 px-1 text-xs text-muted-foreground">
              Answer iteration {last?.n}'s question below to resume. Your answer is the next
              iteration's note.
            </span>
          ) : (
            <>
              <Input
                value={note}
                aria-label={
                  signoff
                    ? "Send back"
                    : resumes
                      ? "Answer and resume"
                      : "Note for the next iteration"
                }
                placeholder={
                  signoff
                    ? "What to change. It goes into the next iteration."
                    : resumes
                      ? "An answer, a decision, a correction. It goes into the next iteration."
                      : `Note for the next iteration: a hint, a decision, a correction.${current ? ` Iteration ${current.iteration.n} is not interrupted.` : ""}`
                }
                onChange={(e) => setNote(e.target.value)}
                className="h-8 flex-1 text-xs"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!resumes && !note.trim()}
                onClick={() => {
                  const body = note.trim();
                  if (resumes) resume.mutate({ ...key, note: body || null });
                  else addNote.mutate({ ...key, body });
                  setNote("");
                }}
              >
                {signoff ? (
                  <>
                    <Undo2 className="size-3" />
                    Send back
                  </>
                ) : resumes ? (
                  <>
                    <Play className="size-3" />
                    Resume
                  </>
                ) : (
                  <>
                    <StickyNote className="size-3" />
                    Add note
                  </>
                )}
              </Button>
            </>
          ))}
      </div>
      {!blocked &&
        pendingNotes.map((c) => (
          <div
            key={c.id}
            className="flex items-start gap-2 rounded-md border border-border bg-accent/5 px-2.5 py-1.5 text-xs"
          >
            <StickyNote className="mt-0.5 size-3.5 shrink-0 text-accent" />
            <span className="flex-1">{c.body}</span>
            <span className="shrink-0 text-muted-foreground">
              goes into iteration {(summary?.counted ?? 0) + 1}
            </span>
          </div>
        ))}
    </div>
  );

  const doneWhen = (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between px-1">
        <h3 className="text-sm font-medium">Done when</h3>
        {real.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {real.length} {real.length === 1 ? "check" : "checks"}
          </span>
        )}
      </div>
      {rows.length > 0 ? (
        <>
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {rows.map((row) =>
              row.kind === "proposal" ? (
                <ProposalRow key={`p-${row.live.id}`} task={task} check={row.live} />
              ) : editing?.key === row.draft.key ? (
                <li key={row.draft.key} className="bg-accent/8 px-3 py-3">
                  <CheckEditor
                    check={row.draft}
                    onChange={(patch) => setCheck(row.draft.key, patch)}
                    onCommandBlur={prefill}
                    onDone={() => setEditing(null)}
                    onCancel={cancelEdit}
                  />
                </li>
              ) : (
                <CheckRow
                  key={row.draft.key}
                  draft={row.draft}
                  readOnly={checksReadOnly}
                  onEdit={() => editCheck(row.draft)}
                  onRemove={() => removeCheck(row.draft.key)}
                />
              ),
            )}
          </ul>
          {!checksReadOnly && (
            // One button: the editor it opens picks the kind, Command first.
            <button
              type="button"
              className="flex items-center gap-1 px-1 text-xs text-accent hover:underline"
              onClick={() => addCheck("Command")}
            >
              <Plus className="size-3.5" />
              Add check
            </button>
          )}
        </>
      ) : (
        <div className="space-y-3 rounded-lg border border-dashed border-border p-6 text-center">
          <div className="text-sm font-medium">No checks yet</div>
          <p className="mx-auto max-w-md text-xs text-muted-foreground">
            A loop runs until all its checks pass, so it needs at least one before it can start.
            Prepare loop opens a session that writes the tests and the checks with you.
          </p>
          {!readOnly && (
            <div className="flex justify-center gap-2">
              {onPrepare && (
                <Button size="sm" variant="outline" onClick={onPrepare}>
                  <Sparkles className="size-3" />
                  Prepare loop
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => addCheck("Command")}>
                Add a check myself
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );

  const settings = (
    <div className="space-y-4">
      {checksLocked && (
        <div className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
          <Lock className="size-3 shrink-0" />
          {summary?.hold ? (
            <span>Locked until iteration {summary.iteration} and its checks end.</span>
          ) : (
            <>
              <span>Locked while iteration {summary?.iteration || 1} runs.</span>
              <button
                type="button"
                className="text-foreground underline"
                onClick={() => pause.mutate(key)}
              >
                Pause to edit
              </button>
            </>
          )}
        </div>
      )}
      {doneWhen}
      <LimitCards
        value={draft}
        onChange={set}
        config={config}
        summary={started ? summary : null}
        readOnly={readOnly}
      />
      <div className="grid grid-cols-2 gap-4">
        <ChecksRunCard value={draft} onChange={set} readOnly={readOnly} />
        <HiddenCard
          value={draft}
          onChange={set}
          projectId={task.project_id}
          baseBranch={baseBranch}
          locked={sealedLocked}
          readOnly={readOnly}
        />
      </div>
    </div>
  );

  if (!started) {
    return <div className="space-y-4">{settings}</div>;
  }

  return (
    <div className="space-y-4">
      {topRow}
      {view === "settings" ? (
        settings
      ) : (
        <>
          {digest?.body && (
            <section className="space-y-2">
              <h3 className="flex items-center justify-between px-1 text-sm font-medium">
                <span className="flex items-center gap-1.5">
                  <BookOpen className="size-4 text-muted-foreground" />
                  Review digest
                </span>
                <span className="text-xs font-normal text-muted-foreground">
                  by the judge, from the notes, iterations and diff
                </span>
              </h3>
              <div className="rounded-lg border border-border bg-card p-3 text-xs leading-relaxed [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_h3]:font-semibold">
                <MarkdownBlock text={digest.body} projectId={task.project_id} />
              </div>
            </section>
          )}
          <LoopIterations
            task={task}
            iterations={iterations}
            checks={checks}
            comments={comments}
            current={current}
            actions={{
              onJoin: session ? onJoin : null,
              onResume: (answer) => resume.mutate({ ...key, note: answer }),
              onTick: (checkId, ticked) => tick.mutate({ ...key, checkId, ticked }),
              onRerunChecks: () => rerun.mutate(key),
              onEditCheck: readOnly ? null : editFlaky,
            }}
          />
        </>
      )}
    </div>
  );
}

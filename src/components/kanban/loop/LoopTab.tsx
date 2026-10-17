import { useState } from "react";
import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Dice5,
  Hourglass,
  Lock,
  MessageCircleQuestion,
  OctagonX,
  Pause,
  Pencil,
  Play,
  Plus,
  Repeat,
  Sparkles,
  StickyNote,
  User,
  X,
  Undo2,
  CornerDownRight,
  GitPullRequest,
  CircleCheck,
} from "lucide-react";
import type {
  LoopCheck,
  LoopCheckKind,
  LoopCheckState,
  LoopIteration,
  Task,
  TaskComment,
} from "@/types/bindings";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { cn } from "@/lib/utils";
import { useNow } from "@/hooks/useNow";
import { MarkdownBlock } from "@/components/execution/activity/MarkdownBlock";
import { useTaskCommentsQuery } from "@/services/task.service";
import {
  useAddLoopNoteMutation,
  useAnswerLoopProposalMutation,
  useLoopChecksQuery,
  useLoopIterationsQuery,
  useOpenAgentGateMutation,
  useRerunLoopChecksMutation,
  useResumeLoopMutation,
  usePauseLoopMutation,
  useTickLoopCheckMutation,
} from "@/services/loop.service";
import { useBoardActions } from "@/store/boardStore";
import { useTaskSession } from "@/contexts/BoardActionsContext";
import { useSessionActivity } from "@/store/sessionActivityStore";
import {
  CHECK_KINDS,
  CheckEditor,
  ChecksRunCard,
  ConnectionToolsLine,
  HiddenCard,
  KIND_HELP,
  LimitCards,
  usePrefillHidden,
} from "./LoopEditor";
import { blankCheck, doneWhenRows, type CheckDraft, type LoopDraft } from "./loop-draft";
import { buildTimeLeft, clockTime, formatDuration, gateLine, loopHalt } from "./loop-state";

const MARKS: Record<LoopCheckState, { icon: typeof Check; tone: string }> = {
  Pass: { icon: Check, tone: "text-success" },
  Fail: { icon: X, tone: "text-destructive" },
  Flaky: { icon: Dice5, tone: "text-warning" },
  Pending: { icon: Circle, tone: "text-muted-foreground/50" },
};

const OUTCOME_DOT: Record<LoopIteration["outcome"], string> = {
  Running: "bg-accent animate-pulse",
  Checked: "bg-muted-foreground/60",
  Interrupted: "bg-amber-500",
  Empty: "bg-muted-foreground/30",
  Failed: "bg-destructive",
  Blocked: "bg-warning",
};

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

function minutesBetween(from: string, to: string | null | undefined): string {
  const end = to ? new Date(to) : new Date();
  return formatDuration((end.getTime() - new Date(from).getTime()) / 1000);
}

function Banner({
  tone,
  icon: Icon,
  title,
  children,
  actions,
}: {
  tone: "amber" | "red" | "green" | "muted";
  icon: typeof Check;
  title: string;
  children?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const tones = {
    amber: ["border-amber-500/40 bg-amber-500/10", "text-amber-600"],
    red: ["border-destructive/30 bg-destructive/10", "text-destructive"],
    green: ["border-success/30 bg-success/10", "text-success"],
    muted: ["border-border bg-muted/40", "text-muted-foreground"],
  }[tone];
  return (
    <div className={cn("flex items-start gap-3 rounded-md border p-3 text-xs", tones[0])}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", tones[1])} />
      <div className="flex-1 space-y-1">
        <div className="font-medium">{title}</div>
        {children && <div className="text-muted-foreground">{children}</div>}
      </div>
      {actions && <div className="flex shrink-0 gap-1.5">{actions}</div>}
    </div>
  );
}

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

/**
 * One of the user's checks: as edited, with the state the daemon last gave it. A failing check's
 * output opens under it, since it is what the next iteration is told.
 */
function CheckRow({
  task,
  draft,
  live,
  readOnly,
  onEdit,
  onRemove,
}: {
  task: Task;
  draft: CheckDraft;
  live: LoopCheck | null;
  readOnly: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const tick = useTickLoopCheckMutation();
  const [open, setOpen] = useState(false);
  const { icon: Mark, tone } = MARKS[live?.state ?? "Pending"];
  const { icon: KindIcon, name } = CHECK_KINDS[draft.kind];
  const failing = live?.state === "Fail" || live?.state === "Flaky";
  const output = failing ? live?.detail?.trim() : undefined;
  const lastLine = live?.detail?.split("\n").filter(Boolean).pop();
  const sub =
    draft.kind === "Command" ? (
      <>
        <span className="font-mono">{draft.command}</span>
        {lastLine && (
          <span
            className={cn(
              live?.state === "Fail" && "text-destructive",
              live?.state === "Flaky" && "text-warning",
            )}
          >
            {" "}
            · {lastLine}
          </span>
        )}
      </>
    ) : (
      (live?.detail?.split("\n")[0] ?? KIND_HELP[draft.kind])
    );
  return (
    <li className={cn("group px-3 py-2.5", live?.state === "Flaky" && "bg-warning/5")}>
      <div className="flex items-start gap-2.5">
        <Mark className={cn("mt-0.5 size-4 shrink-0", tone)} />
        <div className="min-w-0 flex-1">
          <div className="text-sm">{draft.label}</div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">{sub}</div>
        </div>
        <span className="flex shrink-0 items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 text-xs text-muted-foreground">
          <KindIcon className="size-3" />
          {name}
        </span>
        {live && draft.kind === "Manual" && live.kind === "Manual" && (
          <button
            className="shrink-0 text-xs text-accent hover:underline"
            onClick={() =>
              tick.mutate({
                projectId: task.project_id,
                taskId: task.id,
                checkId: live.id,
                ticked: live.state !== "Pass",
              })
            }
          >
            {live.state === "Pass" ? "Untick" : "Mark done"}
          </button>
        )}
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
      {output && (
        <div className="pl-6.5 pt-1">
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-accent hover:underline"
            onClick={() => setOpen(!open)}
          >
            {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            {open ? "Hide output" : "Show output"}
          </button>
          {open && (
            <>
              <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre rounded-md border border-border bg-background p-2 font-mono text-xs leading-relaxed">
                {output}
              </pre>
              <p className="mt-1 text-xs text-muted-foreground">
                The next iteration gets this output, cut to 200 lines. It never sees the hidden
                files themselves.
              </p>
            </>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The running Build's clock and a bar of how much of its time it has used, the time left on the
 * bar's tooltip. Its own component so the one running row is the only one ticking.
 */
function BuildClock({ startedAt, limitSecs }: { startedAt: string; limitSecs: number }) {
  const now = useNow(60_000);
  const used = Math.max(0, (now - new Date(startedAt).getTime()) / 1000);
  const { late, tip } = buildTimeLeft(used, limitSecs);
  return (
    <>
      <span className={cn("tabular-nums text-xs", late ? "text-warning" : "text-muted-foreground")}>
        {formatDuration(used)}
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              role="progressbar"
              aria-label={tip}
              aria-valuemin={0}
              aria-valuemax={limitSecs}
              aria-valuenow={Math.min(used, limitSecs)}
              className="flex h-3 items-center"
            />
          }
        >
          <span className="h-1.5 w-20 rounded-full bg-muted">
            <span
              className={cn("block h-1.5 rounded-full", late ? "bg-warning" : "bg-accent")}
              style={{ width: `${Math.min(100, (used / limitSecs) * 100)}%` }}
            />
          </span>
        </TooltipTrigger>
        <TooltipContent>{tip}</TooltipContent>
      </Tooltip>
    </>
  );
}

function IterationRow({
  iteration,
  buildLimitSecs,
  activity,
  onJoin,
}: {
  iteration: LoopIteration;
  /** The loop's `max_build_secs`, which the running Build is closed at. */
  buildLimitSecs: number | null;
  /** What the running iteration's agent is doing now, while one is. */
  activity: string | null;
  onJoin: (() => void) | null;
}) {
  const running = iteration.outcome === "Running";
  return (
    <li className="flex items-start gap-2.5 px-3 py-2 hover:bg-muted/40">
      <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", OUTCOME_DOT[iteration.outcome])} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">#{iteration.n}</span>
          {running && buildLimitSecs ? (
            <>
              <span className="tabular-nums text-xs text-muted-foreground">
                {time(iteration.started_at)} ·
              </span>
              <BuildClock startedAt={iteration.started_at} limitSecs={buildLimitSecs} />
            </>
          ) : (
            <span className="tabular-nums text-xs text-muted-foreground">
              {time(iteration.started_at)} ·{" "}
              {minutesBetween(iteration.started_at, iteration.ended_at)}
              {running ? " so far" : ""}
            </span>
          )}
          {(iteration.touched_sealed || iteration.peeks.length > 0) && (
            <Tooltip disabled={iteration.peeks.length === 0}>
              <TooltipTrigger
                render={
                  <span className="flex items-center gap-0.5 rounded bg-amber-500/15 px-1 text-xs text-amber-600" />
                }
              >
                <Lock className="size-3" />
                {iteration.touched_sealed ? "touched a hidden file" : "looked for a hidden file"}
              </TooltipTrigger>
              <TooltipContent className="whitespace-pre-line">
                {iteration.peeks.join("\n")}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        {iteration.summary && (
          <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {iteration.summary}
          </div>
        )}
        {iteration.blocked && (
          <div className="mt-0.5 line-clamp-2 text-xs text-warning">
            Blocked: {iteration.blocked}
          </div>
        )}
        {running && activity && (
          <div className="mt-1.5 rounded-md border border-border bg-background p-2 text-xs leading-relaxed">
            {activity}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
        {running ? (
          onJoin && (
            <button
              className="flex items-center gap-1 text-accent hover:underline"
              onClick={onJoin}
            >
              <CornerDownRight className="size-3" />
              Join
            </button>
          )
        ) : iteration.outcome === "Interrupted" ? (
          <span className="text-amber-600">not counted</span>
        ) : (
          <span className="tabular-nums">
            {iteration.files} {iteration.files === 1 ? "file" : "files"}{" "}
            <span className="text-success">+{iteration.added}</span>{" "}
            <span className="text-destructive">−{iteration.removed}</span>
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

/**
 * A loop on one tab: why it waits, its limits, the judge's digest, its checks as a list edited in
 * place, its iterations, the note for the next one, and what runs around the checks. Edits go into
 * the draft, saved with the rest of the task.
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
  const openGate = useOpenAgentGateMutation();
  const { openReview } = useBoardActions();
  const session = useTaskSession(task.id);
  const activity = useSessionActivity(session?.session_id);
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState<Editing | null>(null);

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
  const iterating = task.phase === "Iterating" && task.phase_status === "Running";
  // A Build reads the list when it starts and the checks when they run, so the list holds still
  // while either works. Pause lets the iteration end cleanly, and the lock lifts then.
  const checksLocked = !readOnly && (live || task.phase === "Checking");
  const checksReadOnly = readOnly || checksLocked;
  const rows = doneWhenRows(draft.checks, checks);
  const real = checks.filter((c) => !c.proposed || c.accepted);
  const passing = real.filter((c) => c.state === "Pass").length;
  // The digest describes the work that reached sign-off; while the loop works again it is stale.
  const reviewing = signoff || task.phase === "AwaitingMerge" || task.status === "Done";
  const digest = reviewing ? latest(comments, "digest") : undefined;
  const lastStart = iterations[iterations.length - 1]?.started_at;
  const pendingNotes = comments.filter(
    (c) => c.kind === "steer" && (!lastStart || c.created_at > lastStart),
  );
  const yours = real.filter((c) => c.kind === "Manual" && c.state !== "Pass");
  const flaky = real.filter((c) => c.state === "Flaky");
  const editFlaky = () => {
    const row = draft.checks.find((c) => flaky.some((f) => f.id === c.id));
    if (row) editCheck(row);
  };

  let banner: React.ReactNode = null;
  if (gate && task.gate) {
    const agentGate = task.gate;
    banner = (
      <Banner
        tone="amber"
        icon={Hourglass}
        title={
          agentGate.backoff
            ? `${agentGate.agent_id} hit its usage limit. It tries again at ${clockTime(agentGate.resume_at)}`
            : `Waiting for ${agentGate.agent_id}'s ${gate.label.toLowerCase()} to reset at ${clockTime(agentGate.resume_at)}`
        }
        actions={
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              openGate.mutate({ projectId: task.project_id, agentId: agentGate.agent_id })
            }
          >
            <Play className="size-3" />
            Try now
          </Button>
        }
      >
        The refused iteration was saved as a WIP commit and runs again then, without counting. The
        next session never sees the error.
      </Banner>
    );
  } else if (halt === "Flaky") {
    banner = (
      <Banner
        tone="amber"
        icon={Dice5}
        title={`Paused: ${flaky.map((c) => `"${c.label}"`).join(", ") || "a check"} is flaky`}
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => rerun.mutate(key)}>
              <Repeat className="size-3" />
              Re-run checks
            </Button>
            {!readOnly && (
              <Button size="sm" variant="outline" onClick={editFlaky}>
                Edit the check
              </Button>
            )}
          </>
        }
      >
        It failed, then passed when run again on the same commit. A check that changes its mind
        would spend iterations on nothing, so the loop waits for you. Fix the test on{" "}
        {task.base_branch} or remove the check, then re-run checks. Re-running takes the hidden
        files from {task.base_branch} again and costs no iteration.
      </Banner>
    );
  } else if (halt === "Blocked") {
    const asked = [...iterations].reverse().find((i) => i.blocked)?.blocked;
    banner = (
      <Banner
        tone="amber"
        icon={MessageCircleQuestion}
        title="Blocked: the agent needs your answer"
      >
        {asked && <>It asked: “{asked}” </>}
        Its work so far is committed and the checks did not run. Answer below and resume: the next
        iteration gets your answer with its question.
      </Banner>
    );
  } else if (halt === "Conflict") {
    banner = (
      <Banner tone="red" icon={OctagonX} title="Stopped: an iteration could not be merged back">
        The loop's worktree has changes in the way of the last iteration's commit, which is kept.
        Commit or revert them there, then resume: the next iteration merges it first. Git's reason
        is in the Outcome thread.
      </Banner>
    );
  } else if (halt === "Paused" || halt === "Stopped") {
    banner = (
      <Banner
        tone="muted"
        icon={halt === "Paused" ? Pause : OctagonX}
        title={halt === "Paused" ? "Paused, as you asked" : "Stopped, as you asked"}
      >
        Nothing runs until you resume it. A note below goes into the next iteration.
      </Banner>
    );
  } else if (halt && config && summary) {
    const title = {
      Stalled: `Stopped: ${config.stall_limit} iterations in a row changed nothing`,
      Failing: "Stopped: the last three iterations failed",
      OutOfIterations: `Stopped: the loop used its ${config.max_iterations} iterations`,
    }[halt];
    banner = (
      <Banner tone="red" icon={OctagonX} title={title}>
        {summary.last_summary && <>The agent's last note: “{summary.last_summary}” </>}
        {halt === "OutOfIterations"
          ? "Raise the limit above and save, or answer with a note and resume."
          : "Answer with a note and resume."}
      </Banner>
    );
  } else if (signoff) {
    banner = (
      <Banner
        tone="amber"
        icon={User}
        title={
          yours.length > 0
            ? `Every automatic check passes. ${yours.length === 1 ? "One check is" : `${yours.length} checks are`} yours.`
            : "Every check passes."
        }
        actions={
          <Button size="sm" variant="outline" onClick={() => openReview(task.id)}>
            Review changes
          </Button>
        }
      >
        Read the digest and review the changes.{" "}
        {yours.length > 0 ? "Mark your checks done to approve, " : "Approve it, "}or send it back
        with a note that goes into the next iteration.
      </Banner>
    );
  } else if (task.phase === "AwaitingMerge") {
    banner = (
      <Banner tone="green" icon={GitPullRequest} title="Pull request open">
        The digest is its description. Same merge step as every task.
      </Banner>
    );
  } else if (task.status === "Done") {
    banner = (
      <Banner
        tone="green"
        icon={CircleCheck}
        title={`Done after ${summary?.counted ?? 0} iterations and ${formatDuration(summary?.agent_secs ?? 0)}.`}
      />
    );
  }

  // The note goes into the next iteration; on a loop that waits on the user it is also the answer
  // that lets it go on.
  const resumes = !!halt || signoff;
  const noteBox = (live ||
    resumes ||
    (task.phase_status === "Waiting" && task.ball === "Agent")) && (
    <section className="space-y-2">
      <h3 className="px-1 text-sm font-medium">
        {signoff ? "Send back" : halt ? "Answer and resume" : "Note for the next iteration"}
      </h3>
      {pendingNotes.map((c) => (
        <div
          key={c.id}
          className="flex items-start gap-2 rounded-md border border-border bg-accent/8 p-2 text-xs"
        >
          <StickyNote className="mt-0.5 size-3.5 text-accent" />
          <span className="flex-1">{c.body}</span>
          <span className="text-xs text-muted-foreground">
            goes into iteration {(summary?.counted ?? 0) + 1}
          </span>
        </div>
      ))}
      <div className="flex gap-2">
        {resumes ? (
          <Textarea
            value={note}
            rows={2}
            placeholder={
              signoff
                ? "What to change. It goes into the next iteration."
                : "An answer, a decision, a correction."
            }
            onChange={(e) => setNote(e.target.value)}
            className="flex-1 text-xs"
          />
        ) : (
          <Input
            value={note}
            placeholder="A hint, a decision, a correction. The current iteration is not interrupted."
            onChange={(e) => setNote(e.target.value)}
            className="h-8 flex-1 text-xs"
          />
        )}
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
            "Add note"
          )}
        </Button>
      </div>
    </section>
  );

  const doneWhen = (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between px-1">
        <h3 className="text-sm font-medium">Done when</h3>
        {real.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {passing} of {real.length} pass
          </span>
        )}
      </div>
      {checksLocked && (
        <div className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
          <Lock className="size-3 shrink-0" />
          {summary?.hold ? (
            <span>Locked until iteration {summary.iteration} and its checks end.</span>
          ) : (
            <>
              <span>Locked while iteration {summary?.iteration ?? 1} runs.</span>
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
                  task={task}
                  draft={row.draft}
                  live={row.live}
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

  const iterationList = (
    <section className="space-y-2">
      <h3 className="px-1 text-sm font-medium">Iterations</h3>
      {iterations.length > 0 ? (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {[...iterations].reverse().map((iteration) => (
            <IterationRow
              key={`${iteration.n}-${iteration.attempt}`}
              iteration={iteration}
              buildLimitSecs={config?.max_build_secs ?? null}
              activity={iterating ? (activity?.label ?? "Working") : null}
              onJoin={session ? onJoin : null}
            />
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
          None yet
        </p>
      )}
    </section>
  );

  return (
    <div className="space-y-4">
      {banner}
      <LimitCards
        value={draft}
        onChange={set}
        config={config}
        summary={started ? summary : null}
        readOnly={readOnly}
      />
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
      {started ? (
        <div className="grid grid-cols-2 gap-4">
          {doneWhen}
          {iterationList}
        </div>
      ) : (
        doneWhen
      )}
      {noteBox}
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
      <ConnectionToolsLine />
    </div>
  );
}

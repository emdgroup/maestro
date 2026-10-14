import { useState } from "react";
import {
  BookOpen,
  Check,
  Circle,
  Dice5,
  Hourglass,
  Lock,
  MessageCircleQuestion,
  OctagonX,
  Pause,
  Play,
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
  useTickLoopCheckMutation,
} from "@/services/loop.service";
import { useBoardActions } from "@/store/boardStore";
import { CHECK_KINDS } from "./LoopEditor";
import { clockTime, formatDuration, gateLine, loopHalt } from "./loop-state";

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

/** `1.9M`, `840k`. */
function tokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`;
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

function Meter({
  label,
  value,
  share,
  warn,
}: {
  label: string;
  value: string;
  share: number;
  warn?: boolean;
}) {
  return (
    <div className="flex-1 rounded-md border border-border bg-card p-2">
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">{value}</span>
      </div>
      <div className="mt-1.5 h-1 rounded-full bg-muted">
        <div
          className={cn("h-1 rounded-full", warn ? "bg-destructive" : "bg-accent")}
          style={{ width: `${Math.min(100, Math.max(0, share * 100))}%` }}
        />
      </div>
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
          placeholder="Shell command, exit 0 passes"
          onChange={(e) => setCommand(e.target.value)}
          className="h-8 font-mono text-[11px]"
        />
      )}
      <Input
        value={seal}
        placeholder="Paths to seal, comma separated (they must be on the base branch)"
        onChange={(e) => setSeal(e.target.value)}
        className="h-8 font-mono text-[11px]"
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

function CheckRow({ task, check, onEdit }: { task: Task; check: LoopCheck; onEdit: () => void }) {
  const key = { projectId: task.project_id, taskId: task.id };
  const tick = useTickLoopCheckMutation();
  const answer = useAnswerLoopProposalMutation();
  const [accepting, setAccepting] = useState(false);
  const proposal = check.proposed && !check.accepted;
  const { icon: Mark, tone } = proposal
    ? { icon: Sparkles, tone: "text-accent" }
    : MARKS[check.state];
  const { icon: KindIcon, name } = proposal
    ? { icon: Sparkles, name: "Proposed" }
    : CHECK_KINDS[check.kind];
  // A proposal's detail is the worker's reason, and its command only a suggestion.
  const sub = proposal ? (
    <>
      {check.detail}
      {check.command && (
        <span className="font-mono">
          {check.detail ? " · " : ""}
          {check.command}
        </span>
      )}
    </>
  ) : check.kind === "Command" && check.command ? (
    <>
      <span className="font-mono">{check.command}</span>
      {check.detail && (
        <span className={cn(check.state === "Fail" && "text-destructive")}>
          {" "}
          · {check.detail.split("\n").filter(Boolean).pop()}
        </span>
      )}
    </>
  ) : (
    check.detail?.split("\n")[0]
  );
  return (
    <li
      className={cn(
        "px-3 py-2",
        proposal && "bg-accent/8",
        check.state === "Flaky" && "bg-warning/5",
      )}
    >
      <div className="flex items-start gap-2.5">
        <Mark className={cn("mt-0.5 size-4 shrink-0", tone)} />
        <div className="min-w-0 flex-1">
          <div className="text-xs">{check.label}</div>
          {sub && (
            <div
              className={cn(
                "mt-0.5 text-[11px] text-muted-foreground",
                // A proposal's reason is what the user decides on, so it is not cut to one line.
                proposal ? "line-clamp-3" : "truncate",
              )}
            >
              {sub}
            </div>
          )}
        </div>
        <span className="flex shrink-0 items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          <KindIcon className="size-2.5" />
          {name}
        </span>
        {proposal && !accepting && (
          <span className="flex shrink-0 gap-2 text-[11px]">
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
        {!proposal && check.kind === "Manual" && (
          <button
            className="shrink-0 text-[11px] text-accent hover:underline"
            onClick={() =>
              tick.mutate({ ...key, checkId: check.id, ticked: check.state !== "Pass" })
            }
          >
            {check.state === "Pass" ? "Untick" : "Mark done"}
          </button>
        )}
        {check.state === "Flaky" && (
          <button className="shrink-0 text-[11px] text-accent hover:underline" onClick={onEdit}>
            Edit
          </button>
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

function IterationRow({ iteration, onJoin }: { iteration: LoopIteration; onJoin: () => void }) {
  const running = iteration.outcome === "Running";
  return (
    <li className="flex items-start gap-2.5 px-3 py-2 hover:bg-muted/40">
      <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", OUTCOME_DOT[iteration.outcome])} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium">#{iteration.n}</span>
          <span className="tabular-nums text-muted-foreground">
            {time(iteration.started_at)} ·{" "}
            {minutesBetween(iteration.started_at, iteration.ended_at)}
            {running ? " so far" : ""}
          </span>
          {(iteration.touched_sealed || iteration.peeks.length > 0) && (
            <Tooltip disabled={iteration.peeks.length === 0}>
              <TooltipTrigger
                render={
                  <span className="flex items-center gap-0.5 rounded bg-amber-500/15 px-1 text-[10px] text-amber-600" />
                }
              >
                <Lock className="size-2.5" />
                {iteration.touched_sealed ? "touched a sealed path" : "looked at a sealed path"}
              </TooltipTrigger>
              <TooltipContent className="whitespace-pre-line">
                {iteration.peeks.join("\n")}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        {iteration.summary && (
          <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
            {iteration.summary}
          </div>
        )}
        {iteration.blocked && (
          <div className="mt-0.5 line-clamp-2 text-[11px] text-warning">
            Blocked: {iteration.blocked}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3 text-[11px] text-muted-foreground">
        {running ? (
          <button className="flex items-center gap-1 text-accent hover:underline" onClick={onJoin}>
            <CornerDownRight className="size-3" />
            Join
          </button>
        ) : iteration.outcome === "Interrupted" ? (
          <span className="text-amber-600">not counted</span>
        ) : (
          <>
            <span className="tabular-nums">
              {iteration.files} files <span className="text-success">+{iteration.added}</span>{" "}
              <span className="text-destructive">−{iteration.removed}</span>
            </span>
            {iteration.tokens != null && (
              <span className="tabular-nums">{tokens(iteration.tokens)} tok</span>
            )}
          </>
        )}
      </div>
    </li>
  );
}

/** The newest entry of a kind, or the ones written after a moment. */
const latest = (comments: TaskComment[], kind: string) =>
  [...comments].reverse().find((c) => c.kind === kind);

/**
 * A loop at a glance: why it waits, its budget, the judge's digest, its checks, its iterations,
 * and the note for the next one.
 */
export function LoopTab({
  task,
  onEditChecks,
  onJoin,
}: {
  task: Task;
  onEditChecks: () => void;
  onJoin: () => void;
}) {
  const key = { projectId: task.project_id, taskId: task.id };
  const { data: checks = [] } = useLoopChecksQuery(task.project_id, task.id);
  const { data: iterations = [] } = useLoopIterationsQuery(task.project_id, task.id);
  const { data: comments = [] } = useTaskCommentsQuery(task.project_id, task.id);
  const rerun = useRerunLoopChecksMutation();
  const resume = useResumeLoopMutation();
  const addNote = useAddLoopNoteMutation();
  const openGate = useOpenAgentGateMutation();
  const { openReview } = useBoardActions();
  const [note, setNote] = useState("");

  const config = task.loop_config;
  const summary = task.loop_summary;
  const halt = loopHalt(task);
  const gate = gateLine(task);
  const signoff = task.phase === "Approval";
  const live = task.phase_status === "Running" || task.phase_status === "Blocked";
  const started = (summary?.iteration ?? 0) > 0;
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
            <Button size="sm" variant="outline" onClick={onEditChecks}>
              Edit checks
            </Button>
          </>
        }
      >
        It failed, then passed when run again on the same commit. A check that changes its mind
        would spend iterations on nothing, so the loop waits for you. Fix the test on{" "}
        {task.base_branch} or remove the check, then re-run checks. Re-running takes the sealed
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
      OutOfTime: `Stopped: the loop used its ${formatDuration(config.max_agent_secs)} of agent time`,
    }[halt];
    banner = (
      <Banner tone="red" icon={OctagonX} title={title}>
        {summary.last_summary && <>The agent's last note: “{summary.last_summary}” </>}
        {halt === "OutOfIterations" || halt === "OutOfTime"
          ? "Raise the budget on Details, or answer with a note and resume."
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
    <section className="space-y-1.5">
      <h3 className="px-1 text-[11px] font-medium">
        {signoff ? "Send back" : halt ? "Answer and resume" : "Note for the next iteration"}
      </h3>
      {pendingNotes.map((c) => (
        <div
          key={c.id}
          className="flex items-start gap-2 rounded-md border border-border bg-accent/8 p-2 text-xs"
        >
          <StickyNote className="mt-0.5 size-3.5 text-accent" />
          <span className="flex-1">{c.body}</span>
          <span className="text-[10px] text-muted-foreground">
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

  return (
    <div className="space-y-3">
      {banner}
      {started && config && summary && (
        <div className="flex gap-2">
          <Meter
            label="Iterations"
            value={`${summary.counted} of ${config.max_iterations}`}
            share={summary.counted / config.max_iterations}
          />
          <Meter
            label="Agent time"
            value={`${formatDuration(summary.agent_secs)} of ${formatDuration(config.max_agent_secs)}`}
            share={summary.agent_secs / config.max_agent_secs}
          />
          <Meter
            label="In a row with no change"
            value={`${summary.no_change} of ${config.stall_limit}`}
            share={summary.no_change / config.stall_limit}
            warn={summary.no_change >= config.stall_limit}
          />
        </div>
      )}
      {digest?.body && (
        <section className="space-y-1.5">
          <h3 className="flex items-center justify-between px-1 text-[11px] font-medium">
            <span className="flex items-center gap-1.5">
              <BookOpen className="size-3.5 text-muted-foreground" />
              Review digest
            </span>
            <span className="font-normal text-muted-foreground">
              by the judge, from the notes, iterations and diff
            </span>
          </h3>
          <div className="rounded-lg border border-border bg-card p-3 text-xs leading-relaxed [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_h3]:font-semibold">
            <MarkdownBlock text={digest.body} projectId={task.project_id} />
          </div>
        </section>
      )}
      <div className="grid grid-cols-2 gap-3">
        <section className="space-y-1.5">
          <h3 className="flex justify-between px-1 text-[11px] font-medium">
            <span>Done when</span>
            <span className="text-muted-foreground">
              {passing} of {real.length} pass
            </span>
          </h3>
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {checks.map((check) => (
              <CheckRow key={check.id} task={task} check={check} onEdit={onEditChecks} />
            ))}
          </ul>
        </section>
        <section className="space-y-1.5">
          <h3 className="px-1 text-[11px] font-medium">Iterations</h3>
          {iterations.length > 0 ? (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              {[...iterations].reverse().map((iteration) => (
                <IterationRow
                  key={`${iteration.n}-${iteration.attempt}`}
                  iteration={iteration}
                  onJoin={onJoin}
                />
              ))}
            </ul>
          ) : (
            <p className="rounded-lg border border-dashed border-border p-4 text-center text-[11px] text-muted-foreground">
              None yet
            </p>
          )}
        </section>
      </div>
      {noteBox}
    </div>
  );
}

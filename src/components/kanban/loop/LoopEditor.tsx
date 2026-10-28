import { useState } from "react";
import { DragDropProvider } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { move } from "@dnd-kit/helpers";
import {
  ChevronDown,
  ChevronRight,
  Gavel,
  GripVertical,
  ListOrdered,
  Terminal,
  User,
  X,
} from "lucide-react";
import type { LoopCheckKind, LoopConfig, LoopSummary } from "@/types/bindings";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { cn } from "@/lib/utils";
import { blankCheck, type CheckDraft, type LoopDraft } from "./loop-draft";
import { orderPatterns, pathsInCommand, type CheckOutcome } from "./loop-state";

export const CHECK_KINDS: Record<LoopCheckKind, { icon: typeof Terminal; name: string }> = {
  Command: { icon: Terminal, name: "Command" },
  Judge: { icon: Gavel, name: "Judge" },
  Manual: { icon: User, name: "You" },
  Setup: { icon: ListOrdered, name: "Step" },
};

/** The kinds a check is picked from. A step is added in Before the checks instead. */
export const PICKED_KINDS: LoopCheckKind[] = ["Command", "Judge", "Manual"];

/** What each kind of check means, said where the user picks or reads one. */
export const KIND_HELP: Record<LoopCheckKind, string> = {
  Command: "Passes when the command exits with 0.",
  Judge: "The judge reads the changes against this sentence.",
  Manual: "You tick it before the loop is done.",
  Setup: "Runs before the checks. If it fails, no check runs.",
};

/** A small inline number or duration field, the limit a sentence is about. */
function LimitInput({
  value,
  onChange,
  readOnly,
  label,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  readOnly: boolean;
  label: string;
  placeholder?: string;
}) {
  return (
    <Input
      value={value}
      disabled={readOnly}
      aria-label={label}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="h-6 w-14 px-1.5 text-center text-xs tabular-nums"
    />
  );
}

function LimitCard({
  label,
  used,
  share,
  warn,
  help,
  unit,
  children,
}: {
  label: string;
  /** What has been spent, once the loop has started. */
  used: string | null;
  share: number;
  warn?: boolean;
  help: string;
  unit?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex-1 space-y-1.5 rounded-md border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium">{label}</span>
        <span className="flex items-center gap-1 tabular-nums">
          {used !== null ? (
            <>
              <span>{used}</span>
              <span className="text-muted-foreground">of</span>
            </>
          ) : (
            <span className="text-muted-foreground">stop at</span>
          )}
          {children}
          {unit && <span className="text-muted-foreground">{unit}</span>}
        </span>
      </div>
      {used !== null && (
        <div className="h-1 rounded-full bg-muted">
          <div
            className={cn("h-1 rounded-full", warn ? "bg-destructive" : "bg-accent")}
            style={{ width: `${Math.min(100, Math.max(0, share * 100))}%` }}
          />
        </div>
      )}
      <p className="text-xs text-muted-foreground">{help}</p>
    </div>
  );
}

/**
 * The three limits a loop stops at, each editable where it is shown. Once the loop has started,
 * each also shows what it has spent against the stored limit.
 */
export function LimitCards({
  value,
  onChange,
  config,
  summary,
  readOnly,
}: {
  value: LoopDraft;
  onChange: (patch: Partial<LoopDraft>) => void;
  config: LoopConfig | null;
  /** `null` before the first iteration. */
  summary: LoopSummary | null;
  readOnly: boolean;
}) {
  const started = summary !== null && config !== null;
  return (
    <div className="flex gap-2">
      <LimitCard
        label="Iterations"
        used={started ? String(summary.counted) : null}
        share={started ? summary.counted / config.max_iterations : 0}
        help="The loop stops when it has used them all."
      >
        <LimitInput
          label="Iterations"
          value={value.maxIterations}
          readOnly={readOnly}
          onChange={(maxIterations) => onChange({ maxIterations })}
        />
      </LimitCard>
      {/* Each Build has its own clock, so there is no total to meter. */}
      <LimitCard
        label="Time per Build"
        used={null}
        share={0}
        help="A Build still running then is closed, and what it wrote is checked."
      >
        <LimitInput
          label="Time per Build"
          value={value.buildTime}
          placeholder="2h"
          readOnly={readOnly}
          onChange={(buildTime) => onChange({ buildTime })}
        />
      </LimitCard>
      <LimitCard
        label="Iterations that change nothing"
        unit="in a row"
        used={started ? String(summary.no_change) : null}
        share={started ? summary.no_change / config.stall_limit : 0}
        warn={started && summary.no_change >= config.stall_limit}
        help="The loop stops when this many in a row leave the code as it was."
      >
        <LimitInput
          label="Iterations that change nothing in a row"
          value={value.stallLimit}
          readOnly={readOnly}
          onChange={(stallLimit) => onChange({ stallLimit })}
        />
      </LimitCard>
    </div>
  );
}

/** One check opened for editing, in place of its row. */
export function CheckEditor({
  check,
  defaultMinutes,
  onChange,
  onCommandBlur,
  onDone,
  onCancel,
}: {
  check: CheckDraft;
  /** The loop's time limit, which a check without its own takes. */
  defaultMinutes: number;
  onChange: (patch: Partial<CheckDraft>) => void;
  onCommandBlur: (command: string) => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="flex overflow-hidden rounded-md border border-border bg-card text-xs">
          {PICKED_KINDS.map((kind) => {
            const { icon: Icon, name } = CHECK_KINDS[kind];
            return (
              <button
                key={kind}
                type="button"
                aria-pressed={check.kind === kind}
                onClick={() => onChange({ kind })}
                className={cn(
                  "flex items-center gap-1 px-2 py-1",
                  check.kind === kind
                    ? "bg-accent/12 font-medium text-accent"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-3.5" />
                {name}
              </button>
            );
          })}
        </div>
        <span className="text-xs text-muted-foreground">{KIND_HELP[check.kind]}</span>
      </div>
      <Input
        autoFocus
        value={check.label}
        placeholder="What it checks, as a sentence"
        onChange={(e) => onChange({ label: e.target.value })}
        className="h-8 text-sm"
      />
      {check.kind === "Command" && (
        <div className="flex items-center gap-2">
          <Input
            value={check.command}
            placeholder="The command to run, for example bun run test"
            onChange={(e) => onChange({ command: e.target.value })}
            onBlur={(e) => onCommandBlur(e.target.value)}
            className="h-8 flex-1 font-mono text-xs"
          />
          <TimeLimit
            value={check.timeoutMinutes}
            defaultMinutes={defaultMinutes}
            readOnly={false}
            onChange={(timeoutMinutes) => onChange({ timeoutMinutes })}
          />
        </div>
      )}
      <div className="flex justify-end gap-1.5">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

/** A row's own time limit in minutes; blank takes the loop's, shown as the placeholder. */
export function TimeLimit({
  value,
  defaultMinutes,
  readOnly,
  onChange,
}: {
  value: string;
  defaultMinutes: number;
  readOnly: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs">
      <Input
        value={value}
        disabled={readOnly}
        aria-label="Time limit in minutes"
        placeholder={String(defaultMinutes)}
        onChange={(e) => onChange(e.target.value)}
        className="h-6 w-10 px-1 text-center text-xs tabular-nums"
      />
      <span className="text-muted-foreground">min</span>
    </span>
  );
}

/** The paths the steps and command checks name that the loop's branch holds, files or folders. */
export function namedPaths(drafts: CheckDraft[], files: string[]): string[] {
  const onBranch = (path: string) => {
    const bare = path.replace(/\/$/, "");
    return files.some((f) => f === bare || f.startsWith(`${bare}/`));
  };
  const named = drafts
    .filter((c) => c.kind === "Command" || c.kind === "Setup")
    .flatMap((c) => pathsInCommand(c.command));
  return [...new Set(named)].filter(onBranch);
}

/**
 * The draft with the files `command` names hidden, since they are what the agent must not see:
 * those on the loop's branch, not hidden yet and not taken out by the user. `null` when it adds
 * none.
 */
export function prefillHidden(
  draft: LoopDraft,
  command: string,
  files: string[],
): LoopDraft | null {
  const added = namedPaths([{ ...blankCheck(), command }], files).filter(
    (p) => !draft.sealedPaths.includes(p) && !draft.dismissed.includes(p),
  );
  if (added.length === 0) return null;
  return { ...draft, sealedPaths: orderPatterns([...draft.sealedPaths, ...added]) };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One step: its command and reason edited in place, dragged by its handle. */
function StepRow({
  step,
  index,
  outcome,
  defaultMinutes,
  readOnly,
  onChange,
  onCommandBlur,
  onRemove,
}: {
  step: CheckDraft;
  index: number;
  /** What it concluded after the last iteration; `undefined` before any ran. */
  outcome: CheckOutcome | null | undefined;
  defaultMinutes: number;
  readOnly: boolean;
  onChange: (patch: Partial<CheckDraft>) => void;
  onCommandBlur: (command: string) => void;
  onRemove: () => void;
}) {
  const { ref, handleRef } = useSortable({ id: step.key, index, disabled: readOnly });
  const state = outcome?.result?.state;
  return (
    <li
      ref={ref}
      className={cn("flex items-start gap-2 px-2 py-1.5", state === "Fail" && "bg-destructive/5")}
    >
      {!readOnly && (
        <button
          ref={handleRef}
          type="button"
          aria-label={`Move step ${index + 1}`}
          className="mt-1.5 shrink-0 cursor-grab text-muted-foreground hover:text-foreground"
        >
          <GripVertical className="size-3.5" />
        </button>
      )}
      {outcome !== undefined && (
        <span
          aria-label={state ? state.toLowerCase() : "not run"}
          className={cn(
            "mt-2 size-2 shrink-0 rounded-full",
            state === "Pass" && "bg-success",
            state === "Fail" && "bg-destructive",
            !state && "border border-muted-foreground/50",
          )}
        />
      )}
      <div className="min-w-0 flex-1 space-y-1">
        {readOnly ? (
          <>
            <div className="truncate font-mono text-xs">{step.command}</div>
            <div className="truncate text-xs text-muted-foreground">{step.label}</div>
          </>
        ) : (
          <>
            <Input
              value={step.command}
              aria-label={`Step ${index + 1} command`}
              placeholder="The command, for example bun install"
              onChange={(e) => onChange({ command: e.target.value })}
              onBlur={(e) => onCommandBlur(e.target.value)}
              className="h-7 font-mono text-xs"
            />
            <Input
              value={step.label}
              aria-label={`Step ${index + 1} reason`}
              placeholder="Why it runs, for example Install dependencies"
              onChange={(e) => onChange({ label: e.target.value })}
              className="h-7 text-xs"
            />
          </>
        )}
        {state === "Fail" && outcome?.result?.detail?.trim() && (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-card p-1.5 font-mono text-[11px] leading-4">
            {outcome.result.detail.trim()}
          </pre>
        )}
      </div>
      <TimeLimit
        value={step.timeoutMinutes}
        defaultMinutes={defaultMinutes}
        readOnly={readOnly}
        onChange={(timeoutMinutes) => onChange({ timeoutMinutes })}
      />
      {!readOnly && (
        <button
          type="button"
          aria-label={`Remove step ${index + 1}`}
          className="mt-1 shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onRemove}
        >
          <X className="size-3.5" />
        </button>
      )}
    </li>
  );
}

/**
 * The steps run before each round of checks, in order: an opt-in fold above the checks. The
 * iteration loop runs them; once it has, each shows what it concluded after the last iteration.
 */
export function SetupCard({
  steps,
  last,
  defaultMinutes,
  readOnly,
  onChange,
  onCommandBlur,
}: {
  steps: CheckDraft[];
  /** The last iteration whose checks ran, with its steps' outcomes. */
  last: { n: number; outcomes: CheckOutcome[] } | null;
  defaultMinutes: number;
  readOnly: boolean;
  onChange: (steps: CheckDraft[]) => void;
  onCommandBlur: (command: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const add = () => {
    onChange([...steps, blankCheck("Setup")]);
    setOpen(true);
  };
  if (steps.length === 0) {
    if (readOnly) return null;
    return (
      <button
        type="button"
        onClick={add}
        className="flex w-full items-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-accent hover:bg-accent/8"
      >
        + Add a step before the checks
      </button>
    );
  }
  const outcomeOf = (step: CheckDraft) =>
    last ? (last.outcomes.find((o) => o.check.id === step.id) ?? null) : undefined;
  const failed = last?.outcomes.findIndex((o) => o.result?.state === "Fail") ?? -1;
  const passed = !!last?.outcomes.length && last.outcomes.every((o) => o.result?.state === "Pass");
  const names = steps.map((s) => s.label.trim() || s.command.trim()).filter(Boolean);
  return (
    <section
      className={cn(
        "rounded-lg border bg-card",
        failed >= 0 ? "border-destructive/40" : "border-border",
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs"
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-sm font-medium">Before the checks</span>
        {!open && (
          <span className="min-w-0 truncate text-muted-foreground">
            {plural(steps.length, "step")}
            {names.length > 0 && ` · ${names.join(", ")}`}
          </span>
        )}
        {last && (failed >= 0 || passed) && (
          <span
            className={cn(
              "ml-auto flex shrink-0 items-center gap-1.5",
              failed >= 0 ? "text-destructive" : "text-success",
            )}
          >
            <span
              className={cn("size-2 rounded-full", failed >= 0 ? "bg-destructive" : "bg-success")}
            />
            iteration {last.n}: {failed >= 0 ? `step ${failed + 1} failed` : "every step passed"}
          </span>
        )}
      </button>
      {open && (
        <div className="space-y-2 px-2 pb-2 text-xs">
          <p className="px-2 text-muted-foreground">
            Runs in order before each round of checks. If a step fails, no check runs and they all
            count as failed.{last ? " Changes apply from the next round." : ""}
          </p>
          <div className="rounded-md border border-border bg-background">
            <DragDropProvider
              onDragEnd={(event) => {
                if (event.canceled) return;
                const order = move(
                  steps.map((s) => s.key),
                  event,
                );
                onChange(order.map((key) => steps.find((s) => s.key === key)!));
              }}
            >
              <ul className="divide-y divide-border">
                {steps.map((step, index) => (
                  <StepRow
                    key={step.key}
                    step={step}
                    index={index}
                    outcome={outcomeOf(step)}
                    defaultMinutes={defaultMinutes}
                    readOnly={readOnly}
                    onCommandBlur={onCommandBlur}
                    onChange={(patch) =>
                      onChange(steps.map((s) => (s.key === step.key ? { ...s, ...patch } : s)))
                    }
                    onRemove={() => onChange(steps.filter((s) => s.key !== step.key))}
                  />
                ))}
              </ul>
            </DragDropProvider>
            {!readOnly && (
              <div className="border-t border-border px-3 py-1.5">
                <button type="button" className="text-accent hover:underline" onClick={add}>
                  + Add a step
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

import { useState } from "react";
import { Gavel, Lock, Terminal, User, X } from "lucide-react";
import type { LoopCheckKind, LoopConfig, LoopHiddenFile, LoopSummary } from "@/types/bindings";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { cn } from "@/lib/utils";
import { useMcpServersQuery } from "@/services/mcp.service";
import { useSkillsQuery } from "@/services/skill.service";
import { sealablePaths, useSealablePathsQuery } from "@/services/loop.service";
import { useSelectedProject } from "@/store/projectStore";
import { connectionKeyFromProject } from "@/lib/connection-utils";
import type { CheckDraft, LoopDraft } from "./loop-draft";
import { pathsInCommand } from "./loop-state";

export const CHECK_KINDS: Record<LoopCheckKind, { icon: typeof Terminal; name: string }> = {
  Command: { icon: Terminal, name: "Command" },
  Judge: { icon: Gavel, name: "Judge" },
  Manual: { icon: User, name: "You" },
};

/** What each kind of check means, said where the user picks or reads one. */
export const KIND_HELP: Record<LoopCheckKind, string> = {
  Command: "Passes when the command exits with 0.",
  Judge: "The judge reads the changes against this sentence.",
  Manual: "You tick it before the loop is done.",
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
  onChange,
  onCommandBlur,
  onDone,
  onCancel,
}: {
  check: CheckDraft;
  onChange: (patch: Partial<CheckDraft>) => void;
  onCommandBlur: (command: string) => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="flex overflow-hidden rounded-md border border-border bg-card text-xs">
          {(Object.keys(CHECK_KINDS) as LoopCheckKind[]).map((kind) => {
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
        <Input
          value={check.command}
          placeholder="The command to run, for example bun run test"
          onChange={(e) => onChange({ command: e.target.value })}
          onBlur={(e) => onCommandBlur(e.target.value)}
          className="h-8 font-mono text-xs"
        />
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

/**
 * Adds the files a command names to the hidden list, since they are what the agent must not see.
 * Only paths committed on the base branch can be: the checks take them from there.
 */
export function usePrefillHidden(
  value: LoopDraft,
  onChange: (draft: LoopDraft) => void,
  projectId: number,
  baseBranch: string,
  locked: boolean,
) {
  return (command: string) => {
    if (locked) return;
    const candidates = pathsInCommand(command).filter(
      (p) => !value.sealedPaths.includes(p) && !value.dismissed.includes(p),
    );
    if (candidates.length === 0) return;
    void sealablePaths(projectId, baseBranch, candidates)
      .then((found) => {
        if (found.length > 0) {
          onChange({ ...value, sealedPaths: [...new Set([...value.sealedPaths, ...found])] });
        }
      })
      .catch(() => undefined);
  };
}

/** What runs around the checks: the command before them and how long each may take. */
export function ChecksRunCard({
  value,
  onChange,
  readOnly,
}: {
  value: LoopDraft;
  onChange: (patch: Partial<LoopDraft>) => void;
  readOnly: boolean;
}) {
  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <h3 className="flex items-center gap-1.5 text-sm font-medium">
        <Terminal className="size-4 text-muted-foreground" />
        Running the checks
      </h3>
      <label className="block space-y-1">
        <span className="text-xs font-medium">Run first</span>
        <Input
          value={value.setupCommand}
          disabled={readOnly}
          placeholder="For example npm ci. Leave empty if the checks need nothing."
          onChange={(e) => onChange({ setupCommand: e.target.value })}
          className="h-8 font-mono text-xs"
        />
        <span className="block text-xs text-muted-foreground">
          Runs before each round of checks, to install dependencies or build. If it fails, no check
          runs and they all count as failed.
        </span>
      </label>
      <div className="flex items-center gap-1.5 text-xs">
        <span className="font-medium">A check fails after</span>
        <LimitInput
          label="Check timeout in minutes"
          value={value.timeoutMinutes}
          readOnly={readOnly}
          onChange={(timeoutMinutes) => onChange({ timeoutMinutes })}
        />
        <span className="text-muted-foreground">minutes</span>
      </div>
      <p className="text-xs text-muted-foreground">
        A check that fails, then passes on the same commit, is flaky. The loop pauses so you can fix
        or remove it.
      </p>
    </section>
  );
}

/** A hidden path, or a file kept in Maestro you can open. */
function PathChip({
  path,
  missing,
  onOpen,
  onRemove,
}: {
  path: string;
  /** Why the path is a problem: it is not committed where the checks will look. */
  missing?: string;
  onOpen?: () => void;
  onRemove?: () => void;
}) {
  const chip = (
    <span
      className={cn(
        "flex items-center gap-1.5 rounded-md border bg-background px-2 py-1 font-mono text-xs",
        missing ? "border-amber-500/60 text-amber-600" : "border-border",
      )}
    >
      {onOpen ? (
        <button type="button" className="hover:underline" onClick={onOpen}>
          {path}
        </button>
      ) : (
        path
      )}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${path}`}
          className="text-muted-foreground hover:text-foreground"
          onClick={onRemove}
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  );
  if (!missing) return chip;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{chip}</TooltipTrigger>
      <TooltipContent>{missing}</TooltipContent>
    </Tooltip>
  );
}

const addButton =
  "rounded-md border border-dashed border-border px-2 py-1 text-xs text-accent hover:bg-accent/8";

/**
 * The files kept out of the agent's sandbox: paths committed in the repository, and files that
 * exist only in Maestro. A started loop's paths are fixed, since its worktree is sealed to them;
 * an accepted proposal is what adds one then.
 */
export function HiddenCard({
  value,
  onChange,
  projectId,
  baseBranch,
  locked,
  readOnly,
}: {
  value: LoopDraft;
  onChange: (patch: Partial<LoopDraft>) => void;
  projectId: number;
  baseBranch: string;
  locked: boolean;
  readOnly: boolean;
}) {
  const [newPath, setNewPath] = useState<string | null>(null);
  const [hiddenEdit, setHiddenEdit] = useState<{
    index: number | null;
    file: LoopHiddenFile;
  } | null>(null);
  // A hidden path has to be committed where the checks run, or they will not find it.
  const { data: committed } = useSealablePathsQuery(projectId, baseBranch, value.sealedPaths);
  const missing = (path: string) =>
    committed && !committed.includes(path)
      ? `Not committed on ${baseBranch}, where the checks will look for it. Commit it there, or write it as a file kept in Maestro.`
      : undefined;

  const addPath = () => {
    const path = newPath?.trim().replace(/^\.\//, "");
    if (path && !value.sealedPaths.includes(path)) {
      onChange({
        sealedPaths: [...value.sealedPaths, path],
        dismissed: value.dismissed.filter((p) => p !== path),
      });
    }
    setNewPath(null);
  };

  const saveHidden = () => {
    if (!hiddenEdit) return;
    const file = { path: hiddenEdit.file.path.trim(), content: hiddenEdit.file.content };
    if (!file.path) return;
    const files = [...value.hiddenFiles];
    if (hiddenEdit.index === null) files.push(file);
    else files[hiddenEdit.index] = file;
    onChange({ hiddenFiles: files });
    setHiddenEdit(null);
  };

  const pathsFixed = locked || readOnly;
  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="space-y-1">
        <h3 className="flex items-center gap-1.5 text-sm font-medium">
          <Lock className="size-4 text-muted-foreground" />
          Hidden from the agent
        </h3>
        <p className="text-xs text-muted-foreground">
          The agent works in a copy of the branch without these files, so it cannot read or change
          the tests that judge it. The checks run with the files in place.
        </p>
      </div>

      <div className="space-y-1.5">
        <div className="text-xs font-medium">Files from the repository</div>
        <div className="flex flex-wrap items-center gap-1.5">
          {value.sealedPaths.map((path) => (
            <PathChip
              key={path}
              path={path}
              missing={missing(path)}
              onRemove={
                pathsFixed
                  ? undefined
                  : () =>
                      onChange({
                        sealedPaths: value.sealedPaths.filter((p) => p !== path),
                        dismissed: [...value.dismissed, path],
                      })
              }
            />
          ))}
          {!pathsFixed &&
            (newPath === null ? (
              <button type="button" className={addButton} onClick={() => setNewPath("")}>
                + Add a file or folder
              </button>
            ) : (
              <Input
                autoFocus
                value={newPath}
                placeholder="tests/ or scripts/check.sh"
                onChange={(e) => setNewPath(e.target.value)}
                onBlur={addPath}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addPath();
                  }
                  if (e.key === "Escape") setNewPath(null);
                }}
                className="h-7 w-56 font-mono text-xs"
              />
            ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {locked
            ? "Locked once the loop has started. Accepting a proposed check can still add one."
            : `Each must be committed on ${baseBranch || "the branch the loop starts from"}. Files your check commands name are added for you.`}
        </p>
      </div>

      <div className="space-y-1.5">
        <div className="text-xs font-medium">Files kept in Maestro only</div>
        <div className="flex flex-wrap items-center gap-1.5">
          {value.hiddenFiles.map((file, index) => (
            <PathChip
              key={file.path}
              path={file.path}
              onOpen={readOnly ? undefined : () => setHiddenEdit({ index, file })}
              onRemove={
                readOnly
                  ? undefined
                  : () => onChange({ hiddenFiles: value.hiddenFiles.filter((_, i) => i !== index) })
              }
            />
          ))}
          {!readOnly && (
            <button
              type="button"
              className={addButton}
              onClick={() => setHiddenEdit({ index: null, file: { path: "", content: "" } })}
            >
              + Write a file
            </button>
          )}
        </div>
        {hiddenEdit && (
          <div className="space-y-1.5 rounded-md border border-border bg-background p-2">
            <Input
              value={hiddenEdit.file.path}
              placeholder="acceptance/round-trip.test.ts"
              onChange={(e) =>
                setHiddenEdit({ ...hiddenEdit, file: { ...hiddenEdit.file, path: e.target.value } })
              }
              className="h-7 font-mono text-xs"
            />
            <Textarea
              value={hiddenEdit.file.content}
              rows={6}
              placeholder="The file's content. It exists only here, never in the repository."
              onChange={(e) =>
                setHiddenEdit({
                  ...hiddenEdit,
                  file: { ...hiddenEdit.file, content: e.target.value },
                })
              }
              className="font-mono text-xs"
            />
            <div className="flex justify-end gap-1.5">
              <Button type="button" variant="ghost" size="sm" onClick={() => setHiddenEdit(null)}>
                Cancel
              </Button>
              <Button type="button" size="sm" onClick={saveHidden}>
                Keep it
              </Button>
            </div>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Tests you write here. They are never committed to the repository.
        </p>
      </div>
    </section>
  );
}

/** The skills and MCP servers every session on this connection gets, loop sessions included. */
export function ConnectionToolsLine() {
  const project = useSelectedProject();
  const connection = project ? connectionKeyFromProject(project) : { type: "local" as const };
  const { data: skills } = useSkillsQuery(connection, project?.path ?? "");
  const { data: mcp } = useMcpServersQuery(connection, project?.path ?? "");
  if (!skills && !mcp) return null;
  const skillCount = (skills?.skills.length ?? 0) + (skills?.project.length ?? 0);
  const mcpCount = (mcp?.servers.length ?? 0) + (mcp?.project.length ?? 0);
  return (
    <p className="text-xs text-muted-foreground">
      Every iteration gets {skillCount} skill{skillCount === 1 ? "" : "s"} and {mcpCount} MCP server
      {mcpCount === 1 ? "" : "s"} from this connection.
    </p>
  );
}

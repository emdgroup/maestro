import { useState } from "react";
import { FileText, Gavel, Lock, Plus, Terminal, User, X } from "lucide-react";
import type { LoopCheckKind, LoopHiddenFile } from "@/types/bindings";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
import { NativeSelect, NativeSelectOption } from "@/ui/native-select";
import { cn } from "@/lib/utils";
import { useAgentProfilesQuery } from "@/services/project.service";
import { useMcpServersQuery } from "@/services/mcp.service";
import { useSkillsQuery } from "@/services/skill.service";
import { sealablePaths } from "@/services/loop.service";
import { useSelectedProject } from "@/store/projectStore";
import { connectionKeyFromProject } from "@/lib/connection-utils";
import { blankCheck, type CheckDraft, type LoopDraft } from "./loop-draft";
import { pathsInCommand } from "./loop-state";

export const CHECK_KINDS: Record<LoopCheckKind, { icon: typeof Terminal; name: string }> = {
  Command: { icon: Terminal, name: "Command" },
  Judge: { icon: Gavel, name: "Judged" },
  Manual: { icon: User, name: "You" },
};

const SECOND_FIELD: Record<Exclude<LoopCheckKind, "Command">, string> = {
  Judge: "The judge reads the diff against this sentence",
  Manual: "You tick it at the end",
};

/** A path chip: a sealed path, or a hidden file you can open. */
function PathChip({
  path,
  hidden,
  onOpen,
  onRemove,
}: {
  path: string;
  hidden?: boolean;
  onOpen?: () => void;
  onRemove?: () => void;
}) {
  const Icon = hidden ? FileText : Lock;
  return (
    <span className="flex items-center gap-1 rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px]">
      <Icon className="size-2.5 text-muted-foreground" />
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
          <X className="size-2.5" />
        </button>
      )}
    </span>
  );
}

/** The skills and MCP servers every session on this connection gets, loop sessions included. */
function ConnectionToolsLine() {
  const project = useSelectedProject();
  const connection = project ? connectionKeyFromProject(project) : { type: "local" as const };
  const { data: skills } = useSkillsQuery(connection, project?.path ?? "");
  const { data: mcp } = useMcpServersQuery(connection, project?.path ?? "");
  if (!skills && !mcp) return null;
  const skillCount = (skills?.skills.length ?? 0) + (skills?.project.length ?? 0);
  const mcpCount = (mcp?.servers.length ?? 0) + (mcp?.project.length ?? 0);
  return (
    <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground">
      {skillCount} skill{skillCount === 1 ? "" : "s"} · {mcpCount} MCP server
      {mcpCount === 1 ? "" : "s"} from this connection
    </span>
  );
}

/**
 * A loop's done criteria, what is sealed from its agent, and its budget. The same editor on Create
 * Task and on a loop's Details tab. A started loop's sealed paths are fixed, since its worktree is
 * sealed to them; an accepted proposal is what adds one then.
 */
export function LoopEditor({
  value,
  onChange,
  projectId,
  baseBranch,
  sealedLocked = false,
  readOnly = false,
}: {
  value: LoopDraft;
  onChange: (draft: LoopDraft) => void;
  projectId: number;
  baseBranch: string;
  sealedLocked?: boolean;
  readOnly?: boolean;
}) {
  const { data: profiles } = useAgentProfilesQuery(projectId);
  const judges = (profiles?.profiles ?? []).filter((p) => p.role === "Judge");
  const [newPath, setNewPath] = useState<string | null>(null);
  const [hiddenEdit, setHiddenEdit] = useState<{
    index: number | null;
    file: LoopHiddenFile;
  } | null>(null);

  const set = (patch: Partial<LoopDraft>) => onChange({ ...value, ...patch });
  const setCheck = (key: string, patch: Partial<CheckDraft>) =>
    set({ checks: value.checks.map((c) => (c.key === key ? { ...c, ...patch } : c)) });

  // The files a command names are what the agent must not see, so they are offered as sealed as
  // soon as a command is written. Only paths on the base branch can be: the checks take them there.
  const prefill = (command: string) => {
    if (sealedLocked || readOnly) return;
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

  const addPath = () => {
    const path = newPath?.trim().replace(/^\.\//, "");
    if (path && !value.sealedPaths.includes(path)) {
      set({
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
    set({ hiddenFiles: files });
    setHiddenEdit(null);
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <span className="text-[11px] text-muted-foreground">Done when</span>
          <span className="text-[11px] text-muted-foreground/70">
            Ending its turn is the agent's only claim. Only the checks pass it.
          </span>
        </div>
        <div className="space-y-1.5">
          {value.checks.map((check) => (
            <div key={check.key} className="grid grid-cols-[auto_1fr_1fr_auto] items-center gap-2">
              <div className="flex overflow-hidden rounded-md border border-border">
                {(Object.keys(CHECK_KINDS) as LoopCheckKind[]).map((kind) => {
                  const { icon: Icon, name } = CHECK_KINDS[kind];
                  return (
                    <button
                      key={kind}
                      type="button"
                      title={name}
                      aria-label={name}
                      aria-pressed={check.kind === kind}
                      disabled={readOnly}
                      onClick={() => setCheck(check.key, { kind })}
                      className={cn(
                        "flex size-7 items-center justify-center",
                        check.kind === kind
                          ? "bg-accent/12 text-accent"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <Icon className="size-3.5" />
                    </button>
                  );
                })}
              </div>
              <Input
                value={check.label}
                disabled={readOnly}
                placeholder="What it checks, as a sentence"
                onChange={(e) => setCheck(check.key, { label: e.target.value })}
                className="h-7 text-xs"
              />
              {check.kind === "Command" ? (
                <Input
                  value={check.command}
                  disabled={readOnly}
                  placeholder="Shell command, exit 0 passes"
                  onChange={(e) => setCheck(check.key, { command: e.target.value })}
                  onBlur={(e) => prefill(e.target.value)}
                  className="h-7 font-mono text-[11px]"
                />
              ) : (
                <span className="px-1 text-[11px] text-muted-foreground">
                  {SECOND_FIELD[check.kind]}
                </span>
              )}
              <button
                type="button"
                aria-label="Remove this check"
                disabled={readOnly}
                onClick={() => set({ checks: value.checks.filter((c) => c.key !== check.key) })}
                className="rounded p-1 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
        {!readOnly && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-xs text-accent"
            onClick={() => set({ checks: [...value.checks, blankCheck()] })}
          >
            <Plus className="size-3" />
            Add a check
          </Button>
        )}
      </div>

      <div className="space-y-2 rounded-md border border-border p-3">
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-1.5 text-xs font-medium">
            <Lock className="size-3.5" />
            Sealed from the agent
          </span>
          <span className="text-right text-[11px] text-muted-foreground/70">
            Not in its worktree. Restored only while the checks run, with no session live.
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {value.sealedPaths.map((path) => (
            <PathChip
              key={path}
              path={path}
              onRemove={
                sealedLocked || readOnly
                  ? undefined
                  : () =>
                      set({
                        sealedPaths: value.sealedPaths.filter((p) => p !== path),
                        dismissed: [...value.dismissed, path],
                      })
              }
            />
          ))}
          {!sealedLocked &&
            !readOnly &&
            (newPath === null ? (
              <button
                type="button"
                className="rounded border border-dashed border-border px-1.5 py-0.5 text-[10px] text-accent"
                onClick={() => setNewPath("")}
              >
                + path
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
                className="h-6 w-48 font-mono text-[10px]"
              />
            ))}
        </div>
        <p className="text-[11px] text-muted-foreground">
          {sealedLocked
            ? "Fixed once the loop has started: its worktree is sealed to them. Accepting a proposal adds one."
            : "Prefilled from the files your commands name. Add the tests the agent must not see or change."}
        </p>
        <div className="flex flex-wrap items-center gap-1 pt-1">
          <span className="text-[11px] text-muted-foreground">Hidden files</span>
          {value.hiddenFiles.map((file, index) => (
            <PathChip
              key={file.path}
              path={file.path}
              hidden
              onOpen={readOnly ? undefined : () => setHiddenEdit({ index, file })}
              onRemove={
                readOnly
                  ? undefined
                  : () => set({ hiddenFiles: value.hiddenFiles.filter((_, i) => i !== index) })
              }
            />
          ))}
          {!readOnly && (
            <button
              type="button"
              className="rounded border border-dashed border-border px-1.5 py-0.5 text-[10px] text-accent"
              onClick={() => setHiddenEdit({ index: null, file: { path: "", content: "" } })}
            >
              + write a hidden file
            </button>
          )}
        </div>
        {hiddenEdit && (
          <div className="space-y-1.5 rounded-md border border-border bg-card p-2">
            <Input
              value={hiddenEdit.file.path}
              placeholder="acceptance/round-trip.test.ts"
              onChange={(e) =>
                setHiddenEdit({ ...hiddenEdit, file: { ...hiddenEdit.file, path: e.target.value } })
              }
              className="h-7 font-mono text-[11px]"
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
              className="font-mono text-[11px]"
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
        <p className="text-[11px] text-muted-foreground">
          Acceptance tests that exist only here, never in the repository.
        </p>
      </div>

      <div className="grid grid-cols-5 gap-3">
        <label className="col-span-2 space-y-1">
          <span className="text-[11px] text-muted-foreground">Setup before the checks</span>
          <Input
            value={value.setupCommand}
            disabled={readOnly}
            placeholder="optional"
            onChange={(e) => set({ setupCommand: e.target.value })}
            className="h-8 font-mono text-[11px]"
          />
        </label>
        <label className="space-y-1">
          <span className="text-[11px] text-muted-foreground">Timeout (min)</span>
          <Input
            value={value.timeoutMinutes}
            disabled={readOnly}
            inputMode="numeric"
            onChange={(e) => set({ timeoutMinutes: e.target.value })}
            className="h-8 text-xs"
          />
        </label>
        <label className="space-y-1">
          <span className="text-[11px] text-muted-foreground">Iterations</span>
          <Input
            value={value.maxIterations}
            disabled={readOnly}
            inputMode="numeric"
            onChange={(e) => set({ maxIterations: e.target.value })}
            className="h-8 text-xs"
          />
        </label>
        <label className="space-y-1">
          <span className="text-[11px] text-muted-foreground">Agent time</span>
          <Input
            value={value.agentTime}
            disabled={readOnly}
            placeholder="2h"
            onChange={(e) => set({ agentTime: e.target.value })}
            className="h-8 text-xs"
          />
        </label>
        <label className="col-span-2 space-y-1">
          <span className="text-[11px] text-muted-foreground">Stop after N with no change</span>
          <Input
            value={value.stallLimit}
            disabled={readOnly}
            inputMode="numeric"
            onChange={(e) => set({ stallLimit: e.target.value })}
            className="h-8 text-xs"
          />
        </label>
        <label className="col-span-3 space-y-1">
          <span className="text-[11px] text-muted-foreground">Judge</span>
          <NativeSelect
            size="sm"
            value={value.judgeProfileId ?? ""}
            disabled={readOnly || judges.length === 0}
            onChange={(e) => set({ judgeProfileId: e.target.value || null })}
            className="text-xs"
          >
            <NativeSelectOption value="">Same as the worker</NativeSelectOption>
            {judges.map((profile) => (
              <NativeSelectOption key={profile.id} value={profile.id}>
                {profile.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      </div>
      <div className="flex items-start justify-between gap-4">
        <p className="text-[11px] text-muted-foreground/70">
          A check that fails and then passes on the same commit pauses the loop as flaky, for you to
          fix or remove. Waiting for a usage limit is not agent time. When everything passes, the
          judge writes a digest and the task moves to Review.
        </p>
        <ConnectionToolsLine />
      </div>
    </div>
  );
}

import { useState, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { api } from "@/utils/helpers/tauri-utils";
import { slugifyName } from "@/lib/generateSessionName";
import type { Task, JsonValue, ConnectionKey, AgentRole } from "@/types/bindings";
import { useResolveWorktree } from "@/utils/hooks/useResolveWorktree";
import { useSpawnAcpSessionMutation, useActiveSessionsQuery } from "@/services/execution.service";
import {
  useMarkTaskExecutionStartedMutation,
  useMarkTaskSessionReadyMutation,
  useReleaseTaskExecutionClaimMutation,
} from "@/services/task.service";
import { useDefaultAgent } from "@/store/configStore";
import { useBoardStore } from "@/store/boardStore";
import type { DirtyChoice } from "@/components/execution/DirtyWorktreeDialog";

interface DirtyState {
  modifiedCount: number;
  untrackedCount: number;
  resolve: (choice: DirtyChoice | "cancel") => void;
}

/// Tells the agent how to signal that the task is finished.
///
/// Without it the board can only guess from whether the repository changed, which misreads an
/// agent that edits some files and then stops to ask a question. Kept to a single line at the end
/// of the prompt: it is short enough to read as an instruction rather than noise, and the agent's
/// own marker is stripped from its reply by `acp/completion.rs` so the transcript stays clean.
const COMPLETION_PROTOCOL =
  "When the task is complete and needs no further work, end your final message with `<maestro-task-complete/>` — " +
  "it moves the task to review, so omit it if you are asking a question or reporting a blocker.";

/// What the refiner is for, in the absence of a profile that says it better.
///
/// It is asked for a rewritten description and nothing else, because its final message *is* the
/// proposal: whatever it ends its turn with is what the gate offers to put in the task. A preamble
/// or a summary of what it changed would end up in the description verbatim.
///
/// The instruction not to modify anything is a second line of defence, not the mechanism. The real
/// one is the read-only permission mode below — an instruction is advice, and the proposal gate is
/// only meaningful if accepting it is the first time anything changes.
const REFINER_PROTOCOL =
  "Read whatever you need from the repository, then reply with the improved task description and " +
  "nothing else — no preamble, no summary of your changes, no code fences around the whole reply. " +
  "Your reply is what will replace the description if the user accepts it. The task keeps its " +
  "existing title, so do not restate it as a heading — start with the description itself. Do not " +
  "modify any files.";

/// What the planner is for, in the absence of a profile that says it better.
///
/// Like the refiner, its final message *is* the artifact: the plan is what the gate shows and what
/// the coder is given. It cannot write the plan to a file itself — it is held read-only, which is
/// the whole basis of the plan gate — so Maestro carries it.
const PLANNER_PROTOCOL =
  "Investigate the repository and reply with an implementation plan in markdown: what to change, " +
  "in what order, and anything you found that constrains the approach. Do not modify any files — " +
  "your reply is the plan, and the user decides whether it is implemented.";

/// What the reviewer is for, in the absence of a profile that says it better.
///
/// The verdict line is ordinary text rather than a hidden marker because it is the headline of
/// what goes into the outcome thread — the user reads it, and a stripped marker would leave the
/// thread saying nothing about the conclusion. `classify_verdict` reads only that first line, and
/// treats anything it cannot parse as approval, which sends the task to the human gate rather than
/// spending another coder round on a guess.
const REVIEWER_PROTOCOL =
  "Review the changes on this branch against the task. Start your reply with a single line " +
  "reading exactly `APPROVED` or `CHANGES REQUESTED`, then say why — for changes, be specific " +
  "about what to fix and where, because your reply is what the coder is given. Do not modify any " +
  "files.";

/// Modes that let an agent write, and the read-only ones for the three roles that must not. Used
/// only when no profile names a mode.
///
/// A fallback list, not a ladder: harnesses disagree about what these are called, so this is read
/// in order and the first one *this* agent advertises wins. Every name past the first exists
/// because some harness uses it and no other — the list is expected to grow as harnesses are tried,
/// which is why the resolved mode is logged.
///
/// `acceptEdits` is deliberately absent. It silences prompts for edits but still asks before
/// running a command, and a task in this pipeline is meant to run without a person: stopping on
/// every test run is the failure mode, not a safeguard. `bypassPermissions` is last for the
/// opposite reason — it is the right answer only when a harness offers nothing better.
const WRITABLE_MODES = ["auto", "agent", "build", "full-access", "bypassPermissions"];
const READ_ONLY_MODES = ["readonly", "plan"];

export function useExecuteTask(
  projectId: number | null,
  projectPath: string,
  connection: ConnectionKey,
) {
  const defaultAgent = useDefaultAgent();
  const { resolveWorktree } = useResolveWorktree();
  const spawnAcpSessionMutation = useSpawnAcpSessionMutation();
  const markExecutionStarted = useMarkTaskExecutionStartedMutation();
  const markSessionReady = useMarkTaskSessionReadyMutation();
  const releaseClaim = useReleaseTaskExecutionClaimMutation();
  const [isExecuting, setIsExecuting] = useState(false);
  const [dirtyState, setDirtyState] = useState<DirtyState | null>(null);
  const dirtyResolveRef = useRef<((choice: DirtyChoice | "cancel") => void) | null>(null);

  /// `respectCapacity` belongs to the button, not to this function.
  ///
  /// The scheduler's own picks must not re-check: it counted them against the slots free when it
  /// ran, so asking again once the first has started would defer the rest of its own batch. The
  /// rework restart must not either — that task is not in Queue, and a deferral there would be a
  /// promise the drain has no way to keep.
  ///
  /// `role` decides which profile is resolved, whether the agent gets a worktree, whether it is
  /// held read-only, and — through `mark_task_session_ready` — which column and phase the task
  /// lands in. Everything else about starting an agent is the same for all four.
  ///
  /// `feedback` is what the user wrote at a gate: notes on a plan they want addressed rather than
  /// started over from. Not persisted, because it is only meaningful in the prompt it is about to
  /// become — the plan it refers to is replaced by the one this run produces.
  ///
  /// `unattended` says nobody pressed anything and nobody is watching: the board handed one role's
  /// work to the next. Anything that would stop to ask a question has to be skipped rather than
  /// merely defaulted, because the caller renders none of the dialogs that would ask it.
  const execute = async (
    task: Task,
    {
      respectCapacity = false,
      role: requestedRole = "Coder" as AgentRole,
      feedback = "",
      unattended = false,
    } = {},
  ) => {
    if (!projectId) return;

    // Planning runs first when the project has a planner, which is what "optional plan agent"
    // means in practice — Execute is one button whether or not a plan stage exists.
    //
    // Only from a standing start. At the plan gate the task is at `PlanReview` with a phase, and
    // approving the plan calls this with the coder explicitly; without the guard that approval
    // would start planning again, which is a loop with a gate in it.
    const plannerFirst =
      requestedRole === "Coder" &&
      task.phase == null &&
      (await api
        .resolveAgentProfile(projectId, "Planner", null, [], [], false)
        .then((profile) => profile !== null)
        .catch(() => false));

    const role: AgentRole = plannerFirst ? "Planner" : requestedRole;

    // The refiner reads the repository to sharpen a ticket and writes nothing, so isolating it
    // would cost a worktree per refinement for no benefit. The planner and the reviewer do need
    // one: the planner has to read the branch the work will land on, and the diff being reviewed
    // only exists there.
    const needsWorktree = role !== "Refiner" && task.isolated_worktree;
    const readOnly = role !== "Coder";

    if (respectCapacity) {
      // Advisory. The claim below is what actually decides whether the task starts; this only
      // decides whether it should start *now*, which is the difference between a fixed limit the
      // user set and a reading taken off free memory.
      const decision = await api.requestTaskExecution(projectId, task.id).catch((err) => {
        console.warn("Capacity check failed, starting anyway:", err);
        return null;
      });

      if (decision?.verdict === "Deferred") {
        toast.info(`"${task.title}" will start when an agent is free`, {
          description: decision.reason,
        });
        return;
      }

      if (decision?.verdict === "Warn") {
        toast.warning(`Starting "${task.title}" with the host already full`, {
          description: decision.reason,
        });
      }
    }

    // Resolution order is profile → project override → task override, so the task wins where it
    // says something. Asked for before the capabilities are known because the agent it names is
    // what gets spawned; the model and mode are applied afterwards, once the agent has reported
    // what it supports.
    const roleProfile = await api
      .resolveAgentProfile(projectId, role, null, [], [], false)
      .catch(() => null);

    // The task's own agent is the coder's, so it must not be imposed on the other three: a task
    // pinned to one agent would otherwise have its refiner and reviewer silently pinned too.
    const agentId =
      (role === "Coder" ? task.agent_id : null) ?? roleProfile?.agent_id ?? defaultAgent;
    if (!agentId) {
      toast.error("No agent configured. Set a default agent in Settings.");
      return;
    }

    // Claim before anything is built. The claim marks the task `Spawning`, which is what stops a
    // second click or the auto-mode drain from starting the same task twice, and what makes the
    // in-flight state visible instead of leaving the card looking untouched for the whole spawn.
    //
    // Null means the task is not startable — already being spawned, or moved since the button was
    // rendered. Nothing has been created yet, so there is nothing to tear down.
    const claimed = await markExecutionStarted.mutateAsync(task.id);
    if (!claimed) {
      toast.info(`"${task.title}" is no longer waiting to start`);
      return;
    }

    setIsExecuting(true);
    let logId: number | null = null;
    // Set once the task owns a live session; until then any exit has to hand the claim back.
    let claimHandedOver = false;
    let spawnFailed = false;

    try {
      // Resolve cwd and branch
      const { cwd, branchName } = needsWorktree
        ? await resolveWorktree({
            projectId,
            repoPath: projectPath,
            taskId: task.id,
            baseBranch: task.base_branch,
            newBranchName: `${task.id}-${slugifyName(task.title)}`,
          })
        : { cwd: projectPath, branchName: null };

      // Only for an agent that will write, and only when somebody is there to answer. The prompt
      // exists to stop a coder building on top of someone else's uncommitted work; offering to
      // stash or discard the user's changes before a read-only agent that cannot touch them would
      // be destroying work for no reason at all.
      //
      // A handoff is skipped for two independent reasons, either of which would be enough. The
      // uncommitted work in a handoff's worktree is *this task's own*, left by the round before —
      // stashing or discarding it would destroy the very thing the agent is being asked to carry
      // on from. And nothing renders this dialog on that path: `useAgentPipeline` takes `execute`
      // and none of the dialog state beside it, so the promise below had nothing that could ever
      // resolve it. A live CI fix round deadlocked here over a `.claude/settings.local.json` the
      // agent had written itself, pinned at `Spawning` with the claim never released, because
      // `finally` cannot run on a promise that never settles.
      try {
        const dirtyStatus =
          readOnly || unattended
            ? { modified_count: 0, untracked_count: 0 }
            : await api.checkWorktreeDirty(projectId, cwd);
        if (dirtyStatus.modified_count > 0 || dirtyStatus.untracked_count > 0) {
          const choice = await new Promise<DirtyChoice | "cancel">((resolve) => {
            dirtyResolveRef.current = resolve;
            setDirtyState({
              modifiedCount: dirtyStatus.modified_count,
              untrackedCount: dirtyStatus.untracked_count,
              resolve,
            });
          });
          setDirtyState(null);
          dirtyResolveRef.current = null;
          if (choice === "cancel") return;
          if (choice === "stash") await api.stashWorktree(projectId, cwd);
          if (choice === "discard") await api.discardAllWorktreeChanges(projectId, cwd);
        }
      } catch (err) {
        console.warn("Dirty worktree check failed, proceeding anyway:", err);
      }

      // `[]` means *unknown*, not *none* — the same rule the profile resolver uses.
      //
      // Always a fresh session. A previous role's session is never reused, not even when it runs
      // the same agent in the same worktree: the planner's is closed the moment its plan is taken,
      // because a plan and its implementation can be different agents on different models and a
      // pipeline that only works when they happen to match is a pipeline with a hidden precondition.
      let capturedModeIds: string[] = [];

      const spawnResult = await spawnAcpSessionMutation.mutateAsync({
        agentId,
        cwd,
        sessionName: task.title,
        projectId,
        connection,
        worktreeBranch: branchName ?? null,
        taskId: task.id,
        taskName: task.title,
      });
      logId = spawnResult.log_id;

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          unlistenSpawnOk();
          unlistenSessionError();
          reject(new Error("Agent spawn timed out after 30s"));
        }, 30_000);

        let unlistenSpawnOk: () => void = () => {};
        let unlistenModes: () => void = () => {};
        let unlistenSessionError: () => void = () => {};

        listen<{ current_mode_id: string; available_modes: { mode_id: string }[] }>(
          `acp://session-modes/${logId}`,
          (e) => {
            capturedModeIds = e.payload.available_modes.map((m) => m.mode_id);
            unlistenModes();
          },
        ).then((fn) => {
          unlistenModes = fn;
        });

        listen<null>(`acp://spawn-ok/${logId}`, () => {
          clearTimeout(timer);
          unlistenSpawnOk();
          unlistenModes();
          unlistenSessionError();
          resolve();
        }).then((fn) => {
          unlistenSpawnOk = fn;
        });

        listen<string>(`acp://session-error/${logId}`, (e) => {
          clearTimeout(timer);
          unlistenSpawnOk();
          unlistenModes();
          unlistenSessionError();
          reject(new Error(e.payload));
        }).then((fn) => {
          unlistenSessionError = fn;
        });
      });

      // Asked again now that the agent has said what it supports, so anything it cannot honour is
      // dropped with a warning rather than being sent and silently failing.
      const resolved = await api
        .resolveAgentProfile(projectId, role, null, [], capturedModeIds, false)
        .catch(() => null);

      for (const warning of resolved?.warnings ?? []) {
        toast.warning(warning);
      }

      // A model pinned on the task is pinned for its implementation, not for whichever agent is
      // reading it at the time — same reasoning as the agent id above.
      const model = (role === "Coder" ? task.model_override : null) ?? resolved?.model ?? null;
      if (model) {
        try {
          await api.setAcpModel(logId, model);
        } catch (err) {
          console.warn("Failed to set model:", err);
        }
      }

      // Set permission mode: task override, then the profile, then the modes received at spawn.
      // The task override is the coder's, like the agent and the model — a task set to
      // auto-approve edits must not hand write access to the three roles that exist because they
      // have none.
      const permissionMode =
        (role === "Coder" ? task.permission_mode_override : null) ??
        resolved?.permission_mode ??
        null;
      if (permissionMode) {
        try {
          await api.setAcpMode(logId, permissionMode);
        } catch (err) {
          console.warn("Failed to set permission mode:", err);
        }
      } else if (capturedModeIds.length > 0) {
        try {
          const priorities = readOnly ? READ_ONLY_MODES : WRITABLE_MODES;
          // The read-only fallback deliberately has none: an agent that advertises modes and none
          // of them is read-only has told us it cannot be held. Picking "the least bad writable
          // mode" there would quietly hand write access to a role whose whole point is not having
          // it, so it says so and lets the instruction stand alone.
          const resolvedMode = readOnly
            ? priorities.find((m) => capturedModeIds.includes(m))
            : (priorities.find((m) => capturedModeIds.includes(m)) ??
              capturedModeIds.find((m) => !READ_ONLY_MODES.includes(m)));
          if (resolvedMode) {
            await api.setAcpMode(logId, resolvedMode);
          } else if (readOnly) {
            toast.warning(`${agentId} offers no read-only mode — it is asked not to write instead`);
          }
        } catch (err) {
          console.warn("Failed to set permission mode:", err);
        }
      }

      // Build initial prompt content blocks
      const attachments = await api.listTaskAttachments(task.id);
      const contentBlocks: JsonValue[] = [];

      const promptText = task.description
        ? `# ${task.title}\n\n${task.description}`
        : `# ${task.title}`;
      // Ahead of the task, because it says what this role means for this project — the standing
      // instruction the task is an instance of, not a footnote to it.
      const rolePrompt = resolved?.role_prompt ? `${resolved.role_prompt}\n\n---\n` : "";
      // The refiner is not asked for the completion marker. Its turn ending *is* the proposal —
      // there is nothing for it to declare — and a marker in the reply would end up in the
      // description, since the reply is what the gate offers to put there.
      const protocol =
        role === "Refiner"
          ? REFINER_PROTOCOL
          : role === "Planner"
            ? PLANNER_PROTOCOL
            : role === "Reviewer"
              ? REVIEWER_PROTOCOL
              : COMPLETION_PROTOCOL;
      contentBlocks.push({
        type: "text",
        text: `${rolePrompt}${promptText}\n\n---\n${protocol}`,
      });

      // A re-plan the user asked for rather than a fresh one: they read the plan, wrote down what
      // was wrong with it, and pressed Refine. The planner that wrote it is gone — its session is
      // closed when its plan is taken — so the plan has to be handed back the same way it is handed
      // to a coder, as text.
      //
      // Only when there is feedback. "Plan again" with nothing written means start over, and
      // showing the planner its last attempt is the surest way to get that attempt again.
      if (role === "Planner" && feedback.trim()) {
        const previous = await api
          .listTaskComments(task.id)
          .then((all) => [...all].reverse().find((c) => c.kind === "plan")?.body ?? null)
          .catch(() => null);

        if (previous?.trim()) {
          contentBlocks.push({
            type: "text",
            text: `## Your previous plan\n\n${previous.trim()}`,
          });
        }
        contentBlocks.push({
          type: "text",
          text: `## What the user wants changed about it\n\n${feedback.trim()}\n\nReply with the revised plan in full — it replaces the one above.`,
        });
      }

      // The plan the user approved, carried into the implementation. The coder never inherits the
      // planner's session, so this is the only way the plan reaches it.
      if (role === "Coder") {
        const entries = await api
          .listTaskComments(task.id)
          .then((all) => [...all].reverse())
          .catch(() => []);

        const plan = entries.find((c) => c.kind === "plan")?.body;
        if (plan?.trim()) {
          contentBlocks.push({
            type: "text",
            text: `## The approved plan\n\n${plan.trim()}`,
          });
        }

        // Without this the rework round is a coder restarted on the same task with no idea why,
        // which is the loop spending a round to rediscover what the reviewer already wrote down.
        const verdict = entries.find((c) => c.kind === "verdict")?.body;
        if (task.phase === "Rework" && verdict?.trim()) {
          contentBlocks.push({
            type: "text",
            text: `## Review findings to address\n\n${verdict.trim()}`,
          });
        }

        // A red build on an open pull request. The failing check names rather than their logs:
        // an agent that runs the failing test itself gets a better answer than one reading a
        // truncated CI transcript, and the names are enough to point it at the right one.
        const ci = entries.find((c) => c.kind === "ci")?.body;
        if (task.phase === "AwaitingMerge" && ci?.trim()) {
          contentBlocks.push({
            type: "text",
            text: `## CI is failing on the open pull request\n\n${ci.trim()}\n\nReproduce the failure locally, fix it, and commit. Your commits are pushed to the existing pull request.`,
          });
        }
      }

      if (attachments.length > 0) {
        const files = attachments.map((a) => ({ path: a.file_path, is_image: false }));
        const prepared = await api.prepareExternalAttachments(logId, files, true);
        for (const attachment of prepared) {
          contentBlocks.push(attachment.content_block as JsonValue);
        }
      }

      // Fetch review feedback for rework (if task was sent back with comments). Only the coder
      // acts on it — handing a refiner the last review's per-file comments would have it rewrite
      // the description around code it is not being asked about.
      try {
        const review = role === "Coder" ? await api.getTaskReview(task.id) : null;
        if (review && review.decision === "RequestChanges") {
          let feedbackText = "";

          if (review.comments.length > 0) {
            const grouped = new Map<string, string[]>();
            for (const c of review.comments) {
              const list = grouped.get(c.file_path) ?? [];
              list.push(c.comment);
              grouped.set(c.file_path, list);
            }
            for (const [filePath, comments] of grouped) {
              feedbackText += `## \`${filePath}\`\n`;
              comments.forEach((comment, i) => {
                feedbackText += `### Feedback #${i + 1}\n${comment}\n\n`;
              });
            }
          }

          if (review.general_feedback) {
            feedbackText += `## General feedback\n${review.general_feedback}\n`;
          }

          if (feedbackText) {
            contentBlocks.push({ type: "text", text: feedbackText });
          }
        }
      } catch {
        // Non-critical — proceed without review feedback
      }

      await api.sendAcpPromptStructured(logId, contentBlocks);

      // Clear review from DB after successful injection to prevent re-injection on next cold start
      if (role === "Coder") api.clearTaskReview(task.id).catch(() => {});

      // The session is up and prompted, so the task moves to wherever this role works. Null means
      // it stopped being the task we claimed — the user dragged or stopped it while the spawn was
      // in flight. Their action wins, so the session we just built gets torn down instead.
      const started = await markSessionReady.mutateAsync({ taskId: task.id, role });
      if (!started) {
        api.cancelAcpSession(logId).catch((err) => {
          console.error("Failed to cancel the session of a task that moved mid-spawn:", err);
        });
        toast.info(`"${task.title}" was moved while starting`);
        return;
      }

      claimHandedOver = true;
      toast.success(`Session started for "${task.title}"`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      if (errorMsg === "auth_required") {
        // Remove zombie session but keep the connection server alive for authentication.
        api.discardFailedSpawn(logId!).catch(() => {});
        useBoardStore.getState().setAuthRequired(task.id, agentId!, connection, null);
        return;
      }

      spawnFailed = true;

      if (logId !== null) {
        try {
          await api.cancelAcpSession(logId);
        } catch {
          // best-effort
        }
      }
      toast.error(`Execution failed: ${errorMsg}`);
    } finally {
      // Every exit that did not hand the task a live session gives the claim back — the dirty
      // dialog being cancelled, an auth prompt, a spawn error, or the task having moved. Leaving
      // it claimed would park the card at `Spawning` forever with nothing left to move it on, and
      // the queue drain skips exactly that state.
      //
      // Only a failure leaves the card red: cancelling at a prompt is not something to report.
      if (!claimHandedOver) {
        releaseClaim
          .mutateAsync({ taskId: task.id, failed: spawnFailed })
          .catch((err) => console.error("Failed to release the execution claim:", err));
      }
      setIsExecuting(false);
    }
  };

  const onDirtyChoice = useCallback((choice: DirtyChoice) => {
    dirtyResolveRef.current?.(choice);
  }, []);

  const onDirtyCancel = useCallback(() => {
    dirtyResolveRef.current?.("cancel");
  }, []);

  return {
    execute,
    isExecuting,
    dirtyDialogOpen: dirtyState !== null,
    dirtyModifiedCount: dirtyState?.modifiedCount ?? 0,
    dirtyUntrackedCount: dirtyState?.untrackedCount ?? 0,
    onDirtyChoice,
    onDirtyCancel,
  };
}

export function useTaskActiveSession(taskId: number | null, projectId: number | null) {
  const { data: sessions = [] } = useActiveSessionsQuery(projectId ?? undefined);
  if (taskId === null) return null;
  return sessions.find((s) => s.task_id === taskId) ?? null;
}

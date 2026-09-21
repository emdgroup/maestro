import { useCallback } from "react";
import { toast } from "sonner";
import { api } from "@/lib/tauri-utils";
import { slugifyName, MAESTRO_BRANCH_PREFIX } from "@/lib/generateSessionName";
import { useResolveWorktree } from "@/hooks/useResolveWorktree";
import { useSpawnAcpSessionMutation } from "@/services/execution.service";
import { useWorktreesQuery } from "@/services/worktree.service";
import { useAutomationRunActions } from "@/store/automationRunStore";
import type { Automation, ConnectionKey } from "@/types/bindings";

/**
 * Starts an automation: a workspace, a session, a prompt, and nothing else.
 *
 * Deliberately not `useExecuteTask`. That hook drives a task through the pipeline — claiming the
 * row, resolving the profile for a role, recording phases, handing the result to a gate. An
 * automation has none of those: it is one agent, one prompt, and whatever the prompt asks the
 * agent to produce.
 *
 * The session is an ordinary one. It shows up in the Agents tab like any other, its permission
 * prompts render as usual, and the user can answer or stop it there — which is what makes a mode
 * that asks a survivable choice rather than a hang.
 */
export function useRunAutomation(
  projectId: number,
  projectPath: string,
  connection: ConnectionKey,
) {
  const { resolveWorktree } = useResolveWorktree();
  const spawnAcpSession = useSpawnAcpSessionMutation();
  const { start, finish } = useAutomationRunActions();
  const { data: worktrees } = useWorktreesQuery(projectId, projectPath);

  return useCallback(
    async (automation: Automation) => {
      let cwd = projectPath;
      let branchName: string | null = null;

      try {
        if (automation.workspace_mode === "NewWorktree") {
          const resolved = await resolveWorktree({
            projectId,
            repoPath: projectPath,
            // No task to attach it to, so there is never an existing worktree to reuse: every run
            // branches afresh.
            taskId: null,
            baseBranch: automation.base_branch ?? "",
            newBranchName: `${MAESTRO_BRANCH_PREFIX}${slugifyName(automation.name) || "automation"}`,
            // The name is generated, and a daily automation would otherwise collide with the
            // branch its last run left behind.
            uniqueSuffix: true,
          });
          cwd = resolved.cwd;
          branchName = resolved.branchName;
        } else if (automation.workspace_mode === "ReuseWorkspace") {
          const worktree = (worktrees ?? []).find((w) => w.id === automation.workspace_worktree_id);
          if (!worktree) {
            toast.error(`“${automation.name}” has no workspace`, {
              description: "The workspace it was pinned to is gone. Edit it and pick another.",
            });
            return;
          }
          cwd = worktree.path;
          branchName = worktree.branch_name;
        }

        const { session_id: sessionId } = await spawnAcpSession.mutateAsync({
          agentId: automation.agent_id,
          cwd,
          sessionName: automation.name,
          projectId,
          connection,
          worktreeBranch: branchName,
          // No task and no pipeline role: this session belongs to an automation, and claiming
          // either would put it on a board column and into the phase machine.
          taskId: null,
          taskName: null,
          role: null,
        });

        start(automation.id, sessionId);

        try {
          await api.sendAcpPrompt(sessionId, automation.prompt);
        } catch (error) {
          // The session exists and is the user's to inspect, so it is left open — but the run is
          // over as far as this automation is concerned, since nothing was ever asked of it.
          finish(automation.id);
          throw error;
        }
      } catch (error) {
        toast.error(`“${automation.name}” could not start`, { description: String(error) });
      }
    },
    [
      projectId,
      projectPath,
      connection,
      resolveWorktree,
      spawnAcpSession,
      start,
      finish,
      worktrees,
    ],
  );
}

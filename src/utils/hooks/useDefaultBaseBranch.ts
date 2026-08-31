import { useProjectSettings } from "@/services/project.service";
import { useProjectBranchesQuery } from "@/services/task.service";

/**
 * The branch a new worktree should start from, before the user has said otherwise.
 *
 * The project's configured default when it has one, otherwise the branch the repository is on,
 * which is what every caller did on its own before the setting existed. There is no check that a
 * configured branch still exists: `git worktree add` reports a missing one clearly, and every
 * caller puts a picker next to this value, so a stale setting is visible and fixable rather than
 * silently swapped for something else.
 *
 * Both queries are already fetched at each call site and cached, so this adds no requests.
 */
export function useDefaultBaseBranch(projectId: number | null): string {
  const { data: settings } = useProjectSettings(projectId);
  const { data: branchData } = useProjectBranchesQuery(projectId);
  return settings?.base_branch || branchData?.[1] || "";
}

import { useState } from "react";
import { TriangleAlert, Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/ui/alert-dialog";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import {
  Combobox,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxEmpty,
} from "@/ui/combobox";
import { useProjectBranchesQuery } from "@/services/task.service";
import { useOpenPullRequestForBranch } from "@/services/integration.service";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: number;
  branch: string;
  /** Where the worktree was branched from, used as the default target. */
  baseBranch: string | null;
  /** Names of other live sessions in this same directory, if any. */
  concurrentSessions: string[];
  /** Newest commit's subject, offered as the title. */
  lastCommitSubject: string | null;
  onOpened: (url: string) => void;
}

/**
 * The target branch is offered rather than assumed. A worktree records the ref it was created from,
 * which is often `origin/main` — right for branching, never right as a merge target, since no forge
 * has a branch by that name. Stripping the remote prefix gives the default; the picker exists
 * because the base recorded at creation and the base the work should land on are not always the
 * same branch weeks later.
 */
function defaultTarget(baseBranch: string | null): string {
  if (!baseBranch) return "";
  const slash = baseBranch.indexOf("/");
  return slash >= 0 ? baseBranch.slice(slash + 1) : baseBranch;
}

export function OpenPullRequestDialog({
  open,
  onOpenChange,
  projectId,
  branch,
  baseBranch,
  concurrentSessions,
  lastCommitSubject,
  onOpened,
}: Props) {
  const { data: branches } = useProjectBranchesQuery(open ? projectId : null);
  const openPullRequest = useOpenPullRequestForBranch();

  const [target, setTarget] = useState(() => defaultTarget(baseBranch));
  // The newest commit's subject, because a branch name is a slug and a commit subject is a
  // sentence somebody already wrote about this work. Falls back to the branch only when the
  // worktree has no commit to read — a repository with none, or one git could not be asked about.
  const [title, setTitle] = useState(() => lastCommitSubject ?? branch);

  const localBranches = (branches?.[0]?.local ?? []).filter((name) => name !== branch);
  const canSubmit = target.trim().length > 0 && title.trim().length > 0;

  async function handleSubmit() {
    const result = await openPullRequest.mutateAsync({
      projectId,
      branch,
      base: target.trim(),
      title: title.trim(),
      body: "",
    });
    onOpenChange(false);
    onOpened(result.url);
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Open a pull request</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-mono text-xs">{branch}</span> is pushed and level with its remote.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">Merge into</Label>
            <Combobox value={target} onValueChange={(value) => setTarget(value ?? "")}>
              <ComboboxInput placeholder="Target branch" />
              <ComboboxContent>
                <ComboboxList>
                  {localBranches.length === 0 && <ComboboxEmpty>No other branches</ComboboxEmpty>}
                  {localBranches.map((name) => (
                    <ComboboxItem key={name} value={name}>
                      {name}
                    </ComboboxItem>
                  ))}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
          </div>

          <div className="space-y-1.5">
            <Label className="text-sm font-medium">Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>

          {concurrentSessions.length > 0 && (
            <div className="flex gap-2 rounded-md bg-warning/10 p-2.5 text-xs">
              <TriangleAlert className="size-4 shrink-0 text-warning" />
              <span>
                {concurrentSessions.length === 1
                  ? `${concurrentSessions[0]} is also working in this workspace`
                  : `${concurrentSessions.length} other sessions are working in this workspace`}{" "}
                and may still be writing to this branch.
              </span>
            </div>
          )}

          {openPullRequest.isError && (
            <p className="text-xs text-destructive">{String(openPullRequest.error)}</p>
          )}
        </div>

        <AlertDialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!canSubmit || openPullRequest.isPending}
            onClick={() => void handleSubmit()}
          >
            {openPullRequest.isPending && <Loader2 className="size-4 animate-spin" />}
            Open pull request
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

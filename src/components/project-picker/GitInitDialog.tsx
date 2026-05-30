import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Button } from "@/ui/button";
import { GitBranch, Loader2 } from "lucide-react";

interface GitInitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  path: string;
  onInitGit: () => void;
  onSkip: () => void;
  loading?: boolean;
}

export function GitInitDialog({
  open,
  onOpenChange,
  path,
  onInitGit,
  onSkip,
  loading,
}: GitInitDialogProps) {
  const folderName = path.split("/").pop() ?? path;

  return (
    <Dialog open={open} onOpenChange={loading ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="size-5 text-muted-foreground" />
            Not a Git Repository
          </DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{folderName}</span> is not a git
            repository. Git enables worktree isolation, branch management, and code review features.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-row gap-2 sm:justify-end">
          <Button variant="outline" onClick={onSkip} disabled={loading}>
            Continue Without Git
          </Button>
          <Button onClick={onInitGit} disabled={loading}>
            {loading ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Initializing...
              </>
            ) : (
              "Initialize Git"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import { AlertTriangle } from "lucide-react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/ui/alert-dialog";
import { ChevronDown } from "lucide-react";
import { Button } from "@/ui/button";
import { ButtonGroup } from "@/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/ui/dropdown-menu";

export type DirtyChoice = "ignore" | "stash" | "discard";

interface DirtyWorktreeDialogProps {
  open: boolean;
  modifiedCount: number;
  untrackedCount: number;
  onChoice: (choice: DirtyChoice) => void;
  onCancel: () => void;
}

export function DirtyWorktreeDialog({
  open,
  modifiedCount,
  untrackedCount,
  onChoice,
  onCancel,
}: DirtyWorktreeDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-amber-500" />
            Worktree has uncommitted changes
          </AlertDialogTitle>
          <AlertDialogDescription>
              Target worktree has {modifiedCount} modified and{" "}
              {untrackedCount} untracked files. Choose how to handle them before
              execution starts.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <ButtonGroup>
            <Button size="sm" onClick={() => onChoice("ignore")}>
              Ignore
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button size="sm" className="px-1.5!"><ChevronDown className="size-3.5" /></Button>}
              />
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onClick={() => onChoice("stash")}>
                  Stash — Stash changes, restore after
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => onChoice("discard")}>
                  Discard — Permanently discard all changes
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </ButtonGroup>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

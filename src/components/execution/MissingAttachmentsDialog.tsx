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
import { Button } from "@/ui/button";

/** One attachment row that cannot be sent, and the reason it cannot. */
export interface UnusableAttachment {
  id: number;
  filename: string;
  file_path: string;
  problem: string;
  /** The file is gone from disk, as opposed to present but unsendable — only these get removed. */
  missing: boolean;
}

interface MissingAttachmentsDialogProps {
  open: boolean;
  files: UnusableAttachment[];
  onContinue: () => void;
  onPark: () => void;
}

export function MissingAttachmentsDialog({
  open,
  files,
  onContinue,
  onPark,
}: MissingAttachmentsDialogProps) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(open) => {
        if (!open) onPark();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-amber-500" />
            {files.length === 1
              ? "An attachment cannot be sent"
              : "Some attachments cannot be sent"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {files.some((file) => file.missing)
              ? "Continuing sends the prompt without them, and removes the ones whose file is gone from the task."
              : "Continuing sends the prompt without them. They stay attached to the task."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="space-y-2 text-sm">
          {files.map((file) => (
            <li key={file.id}>
              <div className="font-medium">{file.filename}</div>
              <div className="text-muted-foreground break-all font-mono text-xs">
                {file.file_path}
              </div>
              <div className="text-muted-foreground text-xs">{file.problem}</div>
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onPark}>Park task</AlertDialogCancel>
          <Button size="sm" onClick={onContinue}>
            Continue without them
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

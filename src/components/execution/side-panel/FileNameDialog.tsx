import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Spinner } from "@/ui/spinner";
import { validateEntryName } from "./file-edit-utils";

interface FileNameDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  /** Pre-filled and pre-selected for a rename; empty for a create. */
  initialName?: string;
  /**
   * Names already in the destination directory, when the tree has that listing cached. Empty is
   * legitimate — the backend refuses collisions regardless, this only saves a round trip.
   */
  siblings: readonly string[];
  pending?: boolean;
  onConfirm: (name: string) => void;
  onClose: () => void;
}

export function FileNameDialog({
  open,
  title,
  description,
  confirmLabel,
  initialName = "",
  siblings,
  pending = false,
  onConfirm,
  onClose,
}: FileNameDialogProps) {
  const [name, setName] = useState(initialName);
  const [touched, setTouched] = useState(false);

  // Reset on each opening, so reopening the dialog for another entry does not inherit the previous
  // name or its error. Adjusted during render rather than from an effect, which would show one
  // frame of the stale name.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setName(initialName);
      setTouched(false);
    }
  }

  const error = validateEntryName(name, siblings);
  const showError = touched && error !== null;

  function submit() {
    setTouched(true);
    if (error !== null || pending) return;
    onConfirm(name.trim());
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={name}
          disabled={pending}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setTouched(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          className="font-mono text-xs"
        />
        <p className="text-xs text-destructive min-h-4">{showError ? error : ""}</p>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || error !== null}>
            {pending && <Spinner className="w-3.5 h-3.5" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

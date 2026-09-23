import { useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Button, buttonVariants } from "@/ui/button";
import { Input } from "@/ui/input";
import { useSaveTemplateMutation } from "@/services/template.service";
import { describeTrigger, templateOf } from "./templates";
import type { Automation } from "@/types/bindings";

/** Asks for a name, then keeps the automation's prompt and trigger as a new template. */
export function SaveAsTemplateDialog({
  automation,
  onClose,
}: {
  /** The automation to save from, or `null` when nothing is shown. */
  automation: Automation | null;
  onClose: () => void;
}) {
  const save = useSaveTemplateMutation();
  const [name, setName] = useState("");

  // Starts from the automation's own name each time it opens. Adjusted during render rather than
  // from an effect, which would paint one frame of the previous one.
  const [shownFor, setShownFor] = useState<string | null>(null);
  const current = automation?.id ?? null;
  if (shownFor !== current) {
    setShownFor(current);
    if (automation) setName(automation.name);
  }

  const submit = () => {
    if (!automation || !name.trim()) return;
    save.mutate(
      { id: null, name, body: { kind: "automation", ...templateOf(automation) } },
      {
        onSuccess: () => {
          toast.success("Saved to Templates");
          onClose();
        },
      },
    );
  };

  return (
    <Dialog open={automation !== null} onOpenChange={(open) => !open && onClose()}>
      {automation && (
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Save as template</DialogTitle>
            <DialogDescription>
              Keeps the name, the prompt and the trigger ({describeTrigger(templateOf(automation))}
              ). The agent and the workspace are chosen each time the template is used, in any
              project.
            </DialogDescription>
          </DialogHeader>
          <label className="block min-w-0 space-y-1">
            <span className="text-[11px] text-muted-foreground">Template name</span>
            <Input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && submit()}
              className="h-8 text-xs"
            />
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              className={buttonVariants({ variant: "accent" })}
              disabled={!name.trim() || save.isPending}
              onClick={submit}
            >
              Save template
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/ui/alert-dialog";
import type { CanvasImportChoice, CanvasImportRequest } from "./useCanvasImport";

/**
 * The three questions an import can raise, in the order they come up: do you trust what this
 * surface will talk to, what should happen to the surface it collides with, and — for a file
 * Maestro did not write — should the agent turn it into a canvas at all.
 */
export function CanvasImportDialog({
  request,
  onChoice,
}: {
  request: CanvasImportRequest | null;
  onChoice: (choice: CanvasImportChoice) => void;
}) {
  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onChoice("cancel");
      }}
    >
      <AlertDialogContent>
        {request?.kind === "trust" && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Import “{request.surfaceId}”?</AlertDialogTitle>
              <AlertDialogDescription>
                {request.sources.length === 0 ? (
                  <>This surface declares no external sources, so it makes no requests.</>
                ) : (
                  <>
                    This surface may request{" "}
                    <span className="font-mono text-foreground">{request.sources.join(", ")}</span>.
                    Those requests run from this machine, not from the remote workspace.
                  </>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => onChoice("accept")}>Import</AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
        {request?.kind === "collision" && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>“{request.surfaceId}” is already open</AlertDialogTitle>
              <AlertDialogDescription>
                Replace the surface of that name, or keep both — the imported one is given a new
                name so the agent can tell them apart.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="outline" onClick={() => onChoice("keepBoth")}>
                Keep both
              </AlertDialogAction>
              <AlertDialogAction onClick={() => onChoice("replace")}>Replace</AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
        {request?.kind === "convert" && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Turn “{request.fileName}” into a canvas?</AlertDialogTitle>
              <AlertDialogDescription>
                Maestro did not write this file, so it has no controls the agent can listen to. The
                agent can read it and rebuild it as a canvas, or it can be shown as it is.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="outline" onClick={() => onChoice("viewOnly")}>
                Just show it
              </AlertDialogAction>
              <AlertDialogAction onClick={() => onChoice("convert")}>
                Ask the agent
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}

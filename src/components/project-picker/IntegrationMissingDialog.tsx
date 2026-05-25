import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Button } from "@/ui/button";
import { AlertTriangle } from "lucide-react";
import { useSaveProjectIssueTrackingConfig, PROVIDER_NAMES } from "@/services/integration.service";

interface IntegrationMissingDialogProps {
  open: boolean;
  projectId: number;
  provider: string;
  onFixIntegration: () => void;
  onDropConfig: () => void;
}

export function IntegrationMissingDialog({
  open,
  projectId,
  provider,
  onFixIntegration,
  onDropConfig,
}: IntegrationMissingDialogProps) {
  const { mutateAsync: saveProjectIssueTrackingConfig, isPending } = useSaveProjectIssueTrackingConfig();
  const providerDisplayName = PROVIDER_NAMES[provider] ?? provider;

  async function handleDropConfig() {
    await saveProjectIssueTrackingConfig({ projectId, issueTracking: null });
    onDropConfig();
  }

  return (
    <Dialog open={open}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <AlertTriangle className="size-5 text-amber-500 shrink-0" />
            <DialogTitle>Integration Unavailable</DialogTitle>
          </div>
          <DialogDescription>
            This project uses {providerDisplayName} for issue tracking, but the integration is no longer
            connected.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onFixIntegration} disabled={isPending}>
            Fix Integration
          </Button>
          <Button variant="destructive" onClick={handleDropConfig} disabled={isPending}>
            Remove Issue Tracking Config
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

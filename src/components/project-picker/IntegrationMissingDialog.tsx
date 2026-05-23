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
import { useSaveProjectTicketingConfig } from "@/services/integration.service";

const PROVIDER_NAMES: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  forgejo: "Forgejo",
  linear: "Linear",
  jira_cloud: "Jira Cloud",
  azuredevops: "Azure DevOps",
};

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
  const { mutateAsync: saveProjectTicketingConfig, isPending } = useSaveProjectTicketingConfig();
  const providerDisplayName = PROVIDER_NAMES[provider] ?? provider;

  async function handleDropConfig() {
    await saveProjectTicketingConfig({ projectId, ticketing: null });
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
            This project uses {providerDisplayName} for ticketing, but the integration is no longer
            connected.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onFixIntegration} disabled={isPending}>
            Fix Integration
          </Button>
          <Button variant="destructive" onClick={handleDropConfig} disabled={isPending}>
            Remove Ticketing Config
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

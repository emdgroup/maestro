import { PROVIDER_NAMES } from "@/services/integration.service";
import { BrandIcon } from "@/components/common/brand-icon/BrandIcon";
import { CapabilityTags } from "./IntegrationsPanel";
import { HomeSheet } from "./HomeSheet";

/** Every provider Maestro can connect, in the order the add flow lists them. */
const PROVIDERS = [
  "github",
  "gitlab",
  "bitbucket",
  "azuredevops",
  "gitea",
  "forgejo",
  "jira_cloud",
  "linear",
];

interface ChooseServiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (provider: string) => void;
}

/** The first step of adding an integration: which service. */
export function ChooseServiceDialog({ open, onOpenChange, onChoose }: ChooseServiceDialogProps) {
  return (
    <HomeSheet
      open={open}
      onOpenChange={onOpenChange}
      eyebrow="Add an integration"
      title="Choose a service"
    >
      <div className="mt-5 grid grid-cols-2 gap-2">
        {PROVIDERS.map((provider) => (
          <button
            key={provider}
            type="button"
            onClick={() => onChoose(provider)}
            className="home-pane flex cursor-pointer items-center gap-3 rounded-xl p-3 text-left"
          >
            <BrandIcon slug={provider} className="size-5 shrink-0" />
            <span>
              <span className="block text-xs font-medium">{PROVIDER_NAMES[provider]}</span>
              <span className="mt-1 block">
                <CapabilityTags provider={provider} />
              </span>
            </span>
          </button>
        ))}
      </div>
    </HomeSheet>
  );
}

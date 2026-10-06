import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/ui/button";
import { BrandIcon } from "@/components/common/brand-icon/BrandIcon";
import { useSaveIntegration, PROVIDER_NAMES } from "@/services/integration.service";
import type { IntegrationStatus } from "@/services/integration.service";
import { getProviderFields } from "@/views/home/integrations/integration-provider-config";
import { CapabilityTags } from "./IntegrationsPanel";
import { HomeSheet } from "./HomeSheet";

interface IntegrationDetailsDialogProps {
  integration: IntegrationStatus | null;
  onClose: () => void;
  onDisconnect: (integration: IntegrationStatus) => void;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-xs break-all">{children}</div>
    </div>
  );
}

function Input(props: React.ComponentProps<"input"> & { label: string }) {
  const { label, ...input } = props;
  return (
    <label className="block">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <input {...input} className="home-field mt-1 h-9 w-full rounded-xl px-3 text-xs" />
    </label>
  );
}

/**
 * One integration account: its provider, account and instance, and the way to disconnect it or
 * replace its credentials. An account the gh CLI provides is managed there instead.
 */
export function IntegrationDetailsDialog({
  integration,
  onClose,
  onDisconnect,
}: IntegrationDetailsDialogProps) {
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState("");
  const [instanceUrl, setInstanceUrl] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { mutateAsync: saveIntegration, isPending } = useSaveIntegration();

  if (!integration) return null;
  const provider = integration.provider;
  const fields = getProviderFields(provider);

  const close = () => {
    setEditing(false);
    setToken("");
    setError(null);
    onClose();
  };

  const startEditing = () => {
    setInstanceUrl(integration.instance_url ?? "");
    setEmail(integration.display_name?.includes("@") ? integration.display_name : "");
    setToken("");
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    setError(null);
    try {
      await saveIntegration({
        provider,
        token: token.trim(),
        instanceUrl: instanceUrl.trim() || null,
        email: email.trim() || null,
      });
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <HomeSheet
      open
      onOpenChange={(open) => !open && close()}
      className="sm:max-w-[520px]"
      title={
        <span className="flex items-center gap-3">
          <BrandIcon slug={provider} className="size-5" />
          {PROVIDER_NAMES[provider] ?? provider}
          <CapabilityTags provider={provider} />
        </span>
      }
    >
      {!editing ? (
        <>
          <div className="mt-5 space-y-3">
            {integration.display_name && <Field label="Account">{integration.display_name}</Field>}
            {integration.instance_url && <Field label="Instance">{integration.instance_url}</Field>}
          </div>
          {integration.source === "gh_cli" ? (
            <div className="mt-5 text-xs text-muted-foreground">
              Managed by the gh CLI. Sign out there to remove it.
            </div>
          ) : (
            <div className="mt-6 flex">
              <Button
                variant="ghost"
                className="text-rose-600 hover:bg-rose-500/10 hover:text-rose-600 dark:text-rose-400 dark:hover:text-rose-400"
                onClick={() => onDisconnect(integration)}
              >
                Disconnect
              </Button>
              <Button className="ml-auto" onClick={startEditing}>
                Edit credentials
              </Button>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="mt-5 space-y-3">
            {fields.showInstanceUrl && (
              <Input
                label={fields.instanceUrlLabel}
                placeholder={fields.instanceUrlPlaceholder}
                value={instanceUrl}
                onChange={(e) => setInstanceUrl(e.target.value)}
                disabled={isPending}
              />
            )}
            {fields.showEmail && (
              <Input
                label="Email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isPending}
              />
            )}
            <Input
              label={fields.tokenLabel}
              type="password"
              placeholder={`Enter a new ${fields.tokenLabel.toLowerCase()}`}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={isPending}
              autoFocus
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
          <div className="mt-6 flex gap-2">
            <Button
              variant="ghost"
              className="mr-auto"
              onClick={() => setEditing(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button onClick={save} disabled={isPending || !token.trim()}>
              {isPending && <Loader2 className="size-4 animate-spin" />}
              Save
            </Button>
          </div>
        </>
      )}
    </HomeSheet>
  );
}

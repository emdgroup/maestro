import { useState } from "react";
import { Webhook } from "lucide-react";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import {
  useSetWebhookSettingsMutation,
  useWebhookSettingsQuery,
} from "@/services/automation.service";
import { localBase } from "@/views/library/automations/webhook-url";
import type { ConnectionKey, WebhookSettings } from "@/types/bindings";

/**
 * The webhook listener of this host's background server, shared by every project on it.
 *
 * Edited as a draft and saved as one, because a save rebinds the listener and a half-typed port
 * would take it down on every keystroke.
 */
export function WebhooksSection({ connection }: { connection: ConnectionKey }) {
  const { data: status } = useWebhookSettingsQuery(connection);
  const save = useSetWebhookSettingsMutation();
  const [draft, setDraft] = useState<WebhookSettings | null>(null);

  if (!status) return null;
  const current = draft ?? status.settings;
  const changed = draft !== null && JSON.stringify(draft) !== JSON.stringify(status.settings);
  const exposed = current.bind_address !== "127.0.0.1" && current.bind_address !== "::1";

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-4">
      <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
        <Webhook className="w-4 h-4 text-muted-foreground" />
        Webhooks
      </h3>

      <p className="text-xs text-muted-foreground">
        Where this host's background server listens for webhooks, for every project on it. It only
        listens on this machine unless you say otherwise. To receive webhooks from the internet, put
        a tunnel (cloudflared, ngrok, Tailscale Funnel) or a reverse proxy in front of it and enter
        the address it gives you as the public URL.
      </p>

      <p className={status.error ? "text-xs text-destructive" : "text-xs text-emerald-600"}>
        {status.error ?? `Listening on ${localBase(status.settings)}`}
      </p>

      <div className="grid grid-cols-[8rem_1fr] items-center gap-x-3 gap-y-2">
        <Label htmlFor="webhook-public-url" className="text-sm">
          Public URL
        </Label>
        <Input
          id="webhook-public-url"
          value={current.public_url ?? ""}
          placeholder="https://hooks.example.com"
          onChange={(event) => setDraft({ ...current, public_url: event.target.value || null })}
          className="h-8 text-xs"
        />
        <Label htmlFor="webhook-port" className="text-sm">
          Port
        </Label>
        <Input
          id="webhook-port"
          type="number"
          min={1}
          max={65535}
          value={current.port}
          onChange={(event) => setDraft({ ...current, port: Number(event.target.value) || 0 })}
          className="h-8 w-28 text-xs"
        />
        <Label htmlFor="webhook-bind" className="text-sm">
          Listen on
        </Label>
        <Input
          id="webhook-bind"
          value={current.bind_address}
          placeholder="127.0.0.1"
          onChange={(event) => setDraft({ ...current, bind_address: event.target.value })}
          className="h-8 w-40 font-mono text-xs"
        />
      </div>

      <p className="text-[11px] text-muted-foreground">
        {exposed
          ? "Other machines can reach this address. Only do this for a proxy or tunnel on another machine: requests arrive over plain HTTP, and the per-automation secret is then the only protection."
          : "127.0.0.1 is only reachable from this machine, which is enough for a tunnel or proxy running here. Use 0.0.0.0 or a network address for one on another machine."}
      </p>

      <div className="flex justify-end gap-2">
        {changed && (
          <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
            Cancel
          </Button>
        )}
        <Button
          size="sm"
          disabled={!changed || save.isPending}
          onClick={() =>
            save.mutate({ connection, settings: current }, { onSuccess: () => setDraft(null) })
          }
        >
          Save
        </Button>
      </div>
    </div>
  );
}

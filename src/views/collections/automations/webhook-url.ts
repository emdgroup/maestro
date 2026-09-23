import type { WebhookSettings, WebhookStatus } from "@/types/bindings";

/** The address the listener is reached on from this machine, for when no public one is set. */
export function localBase(settings: WebhookSettings): string {
  const host =
    settings.bind_address === "0.0.0.0" || settings.bind_address === "::"
      ? "127.0.0.1"
      : settings.bind_address;
  return `http://${host.includes(":") ? `[${host}]` : host}:${settings.port}`;
}

/** Where a sender posts to start this automation: the public URL when one is set, else local. */
export function webhookUrl(status: WebhookStatus, automationId: string): string {
  return `${status.settings.public_url ?? localBase(status.settings)}/hooks/${automationId}`;
}

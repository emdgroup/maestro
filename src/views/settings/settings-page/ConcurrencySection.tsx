import { Cpu } from "lucide-react";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group";
import { useSettings, useSaveSettings } from "@/services/settings.service";
import type { AppSettings, ConcurrencyMode } from "@/types/bindings";

/// Mirrors `execution::capacity`. Duplicated rather than plumbed through an IPC call because it is
/// explanatory text, and a round trip to render a sentence is not worth the coupling — but it has
/// to stay in step with the constants there.
const MB_PER_AGENT = 400;
const RESERVED_MB = 1024;

export function ConcurrencySection() {
  const { data: appSettings } = useSettings();
  const saveAppSettings = useSaveSettings({ successToast: false });

  if (!appSettings) return null;

  const update = (patch: Partial<AppSettings>) =>
    saveAppSettings.mutate({
      ...appSettings,
      ...patch,
      updated_at: new Date().toISOString(),
    } as AppSettings);

  const mode = appSettings.concurrency_mode;

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-4">
      <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
        <Cpu className="w-4 h-4 text-muted-foreground" />
        Running agents
      </h3>

      <p className="text-xs text-muted-foreground">
        How many agents auto-mode runs at once. The limit is per host, not per project — two
        projects on the same machine share it. A session parked in Review still holds a slot, which
        is what stops the board filling with reviews faster than you can read them.
      </p>

      <RadioGroup
        value={mode}
        onValueChange={(value) => update({ concurrency_mode: value as ConcurrencyMode })}
        className="space-y-3"
      >
        <div className="flex items-start gap-3">
          <RadioGroupItem value="Hard" id="concurrency-hard" className="mt-1" />
          <div className="min-w-0 flex-1">
            <Label htmlFor="concurrency-hard" className="text-sm font-medium">
              A fixed number
            </Label>
            <div className="text-xs text-muted-foreground">
              Always this many, whatever else the machine is doing.
            </div>
            <Input
              type="number"
              min={0}
              max={64}
              value={appSettings.max_concurrent_agents}
              onChange={(e) => {
                const parsed = Number.parseInt(e.target.value, 10);
                if (Number.isFinite(parsed)) {
                  update({ max_concurrent_agents: Math.max(0, Math.min(64, parsed)) });
                }
              }}
              className="mt-2 h-8 w-24"
            />
          </div>
        </div>

        <div className="flex items-start gap-3">
          <RadioGroupItem value="Auto" id="concurrency-auto" className="mt-1" />
          <div className="min-w-0 flex-1">
            <Label htmlFor="concurrency-auto" className="text-sm font-medium">
              From free memory
            </Label>
            <div className="text-xs text-muted-foreground">
              {MB_PER_AGENT} MB per agent, with {RESERVED_MB / 1024} GB left for the system — so 5
              GB free runs 10. Recalculated each time the queue moves. Hosts whose memory cannot be
              read fall back to the fixed number above.
            </div>
          </div>
        </div>
      </RadioGroup>
    </div>
  );
}

import { Cpu } from "lucide-react";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group";
import { useConnectionCapacity, useSaveConnectionCapacity } from "@/services/settings.service";
import type { ConcurrencyMode, ConnectionCapacitySettings, ConnectionKey } from "@/types/bindings";

export function ConcurrencySection({ connection }: { connection: ConnectionKey }) {
  const { data: capacity } = useConnectionCapacity(connection);
  const saveCapacity = useSaveConnectionCapacity();

  if (!capacity) return null;

  const update = (patch: Partial<ConnectionCapacitySettings>) =>
    saveCapacity.mutate({ connection, settings: { ...capacity, ...patch } });

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-4">
      <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
        <Cpu className="w-4 h-4 text-muted-foreground" />
        Running agents
      </h3>

      <p className="text-xs text-muted-foreground">
        How many agents auto-mode runs at once on this host. Every project on it shares the limit,
        because they share its memory. A session parked in Review still holds a slot, which is what
        stops the board filling with reviews faster than you can read them.
      </p>

      <RadioGroup
        value={capacity.concurrency_mode}
        onValueChange={(value) => update({ concurrency_mode: value as ConcurrencyMode })}
        className="space-y-3"
      >
        <div className="flex items-start gap-3">
          <RadioGroupItem tone="accent" value="Auto" id="concurrency-auto" className="mt-1" />
          <div className="min-w-0 flex-1">
            <Label htmlFor="concurrency-auto" className="text-sm font-medium">
              From free memory
            </Label>
            <div className="text-xs text-muted-foreground">
              Estimate the number of agents that can run based on available memory.
            </div>
          </div>
        </div>

        <div className="flex items-start gap-3">
          <RadioGroupItem tone="accent" value="Hard" id="concurrency-hard" className="mt-1" />
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
              value={capacity.max_concurrent_agents}
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
      </RadioGroup>
    </div>
  );
}

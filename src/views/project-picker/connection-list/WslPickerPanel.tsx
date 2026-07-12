import { Terminal } from "lucide-react";
import {
  useWslDistros,
  useWslConnections,
  useSaveWslConnection,
} from "@/services/connection.service";
import { PanelHeader } from "./PanelHeader";

export function WslPickerPanel({ onBack, onAdded }: { onBack: () => void; onAdded: () => void }) {
  const { data: wslDistros = [] } = useWslDistros();
  const { data: wslConnections = [] } = useWslConnections();
  const saveWsl = useSaveWslConnection();

  const savedDistroNames = new Set(wslConnections.map((c) => c.distro_name));
  const unsavedDistros = wslDistros.filter((d) => !savedDistroNames.has(d.name));

  return (
    <>
      <PanelHeader onBack={onBack} title="WSL" />
      <div className="flex-1 overflow-auto custom-scrollbar">
        {unsavedDistros.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center px-4 py-8">
            All WSL distros already added
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2.5 p-3.5">
            {unsavedDistros.map((distro) => (
              <button
                key={distro.name}
                type="button"
                disabled={saveWsl.isPending}
                onClick={() =>
                  saveWsl.mutate(
                    { distroName: distro.name, displayName: null },
                    { onSuccess: onAdded },
                  )
                }
                className="flex items-center gap-3.5 p-3.5 rounded-lg border border-border bg-muted/50 text-left cursor-pointer transition-all duration-150 hover:border-accent hover:bg-accent/[0.08] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <div className="w-9 h-9 rounded-lg bg-accent/15 flex items-center justify-center shrink-0 text-accent">
                  <Terminal className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold truncate">{distro.name}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

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
          unsavedDistros.map((distro) => (
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
              className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="w-8 h-8 rounded-md bg-muted flex items-center justify-center shrink-0">
                <Terminal className="w-4 h-4" />
              </div>
              <div className="flex-1 text-left min-w-0">
                <div className="text-sm font-medium">{distro.name}</div>
              </div>
            </button>
          ))
        )}
      </div>
    </>
  );
}

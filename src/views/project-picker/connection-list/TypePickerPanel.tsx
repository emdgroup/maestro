import { Server, Terminal, Container, ChevronRight } from "lucide-react";
import { useWslDistros, useDockerContainers } from "@/services/connection.service";
import { PanelHeader } from "./PanelHeader";

export function TypePickerPanel({
  onBack,
  onSsh,
  onWsl,
  onContainer,
}: {
  onBack: () => void;
  onSsh: () => void;
  onWsl: () => void;
  onContainer: () => void;
}) {
  const { data: wslDistros = [] } = useWslDistros();
  const { isError: containerCliMissing } = useDockerContainers();

  return (
    <>
      <PanelHeader onBack={onBack} title="Add connection" />
      <div className="flex-1 overflow-auto">
        <button
          type="button"
          onClick={onSsh}
          className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/50 transition-colors"
        >
          <div className="w-8 h-8 rounded-md bg-muted flex items-center justify-center shrink-0">
            <Server className="w-4 h-4" />
          </div>
          <div className="flex-1 text-left min-w-0">
            <div className="text-sm font-medium">SSH</div>
            <div className="text-xs text-muted-foreground">Remote server via key or password</div>
          </div>
          <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
        </button>
        {wslDistros.length > 0 && (
          <button
            type="button"
            onClick={onWsl}
            className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/50 transition-colors"
          >
            <div className="w-8 h-8 rounded-md bg-muted flex items-center justify-center shrink-0">
              <Terminal className="w-4 h-4" />
            </div>
            <div className="flex-1 text-left min-w-0">
              <div className="text-sm font-medium">WSL</div>
              <div className="text-xs text-muted-foreground">Windows Subsystem for Linux</div>
            </div>
            <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
          </button>
        )}
        {!containerCliMissing && (
          <button
            type="button"
            onClick={onContainer}
            className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/50 transition-colors"
          >
            <div className="w-8 h-8 rounded-md bg-muted flex items-center justify-center shrink-0">
              <Container className="w-4 h-4" />
            </div>
            <div className="flex-1 text-left min-w-0">
              <div className="text-sm font-medium">Container</div>
              <div className="text-xs text-muted-foreground">Docker, Podman, or nerdctl</div>
            </div>
            <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
          </button>
        )}
      </div>
    </>
  );
}

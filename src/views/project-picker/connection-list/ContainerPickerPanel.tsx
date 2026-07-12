import { Container } from "lucide-react";
import {
  useDockerContainers,
  useDockerConnections,
  useSaveDockerConnection,
} from "@/services/connection.service";
import { PanelHeader } from "./PanelHeader";

export function ContainerPickerPanel({
  onBack,
  onAdded,
}: {
  onBack: () => void;
  onAdded: () => void;
}) {
  const { data: containers = [], isLoading: containersLoading } = useDockerContainers();
  const { data: dockerConnections = [] } = useDockerConnections();
  const saveDocker = useSaveDockerConnection();

  const savedContainerNames = new Set(dockerConnections.map((c) => c.container_name));
  const availableContainers = containers.filter((c) => !savedContainerNames.has(c.name));

  return (
    <>
      <PanelHeader onBack={onBack} title="Container" />
      <div className="flex-1 overflow-auto custom-scrollbar">
        {containersLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="w-5 h-5 rounded-full border-2 border-muted-foreground/30 border-t-foreground animate-spin" />
          </div>
        ) : availableContainers.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center px-4 py-8">
            No containers found. Is Docker/Podman running?
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2.5 p-3.5">
            {availableContainers.map((container) => {
              const isStopped = container.state === "Stopped";
              return (
                <button
                  key={container.id}
                  type="button"
                  disabled={isStopped || saveDocker.isPending}
                  onClick={() =>
                    saveDocker.mutate(
                      {
                        containerName: container.name,
                        imageName: container.image ?? null,
                        displayName: null,
                      },
                      { onSuccess: onAdded },
                    )
                  }
                  className={`flex items-center gap-3.5 p-3.5 rounded-lg border border-border bg-muted/50 text-left transition-all duration-150 ${
                    isStopped
                      ? "opacity-35 cursor-not-allowed"
                      : "cursor-pointer hover:border-accent hover:bg-accent/[0.08]"
                  }`}
                >
                  <div
                    className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                      isStopped ? "bg-muted text-muted-foreground" : "bg-accent/15 text-accent"
                    }`}
                  >
                    <Container className="w-4 h-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold truncate">{container.name}</div>
                    {container.image && (
                      <div className="text-xs text-muted-foreground truncate mt-0.5">
                        {container.image}
                      </div>
                    )}
                  </div>
                  <span
                    className={`text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full shrink-0 ${
                      isStopped
                        ? "bg-muted-foreground/15 text-muted-foreground"
                        : "bg-success/15 text-success"
                    }`}
                  >
                    {isStopped ? "Stopped" : "Running"}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

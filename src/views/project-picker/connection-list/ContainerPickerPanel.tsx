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
          availableContainers.map((container) => {
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
                className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/50 transition-colors disabled:opacity-50 ${
                  isStopped ? "cursor-not-allowed" : ""
                }`}
              >
                <div className="w-8 h-8 rounded-md bg-muted flex items-center justify-center shrink-0">
                  <Container className="w-4 h-4" />
                </div>
                <div className="flex-1 text-left min-w-0">
                  <div className="text-sm font-medium truncate">{container.name}</div>
                  {container.image && (
                    <div className="text-xs text-muted-foreground truncate">{container.image}</div>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>
    </>
  );
}

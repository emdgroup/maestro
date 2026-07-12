import { useState } from "react";
import { SshAuthModal } from "../ssh-auth-modal/SshAuthModal";
import { useSshConnectionManager } from "@/utils/hooks/useSshConnectionManager";
import { useProjectPickerNavigation } from "@/utils/hooks/useProjectPickerNavigation";
import { useConnectionContext } from "@/contexts/ConnectionContext";
import type { Connection } from "@/contexts/ConnectionContext";
import { ConnectionListPanel } from "./ConnectionListPanel";
import { TypePickerPanel } from "./TypePickerPanel";
import { SshFormPanel } from "./SshFormPanel";
import { WslPickerPanel } from "./WslPickerPanel";
import { ContainerPickerPanel } from "./ContainerPickerPanel";

type Screen = "list" | "type-picker" | "ssh-form" | "wsl-picker" | "container-picker";

export function ConnectionList() {
  const [screen, setScreen] = useState<Screen>("list");
  const { navigateToProjects } = useProjectPickerNavigation();
  const { startPreflight } = useConnectionContext();

  const handleConnectionClick = (connection: Connection) => {
    navigateToProjects(connection);
    void startPreflight(connection);
  };

  const {
    username,
    connections,
    savedKeyFiles,
    loading,
    showAuthModal,
    handleConnection,
    handleNewConnection,
    handleAuthSubmit,
    handleAuthCancel,
  } = useSshConnectionManager({ onConnectionSuccess: handleConnectionClick });

  const panelOffset = screen === "list" ? 0 : screen === "type-picker" ? -(100 / 3) : -(200 / 3);

  return (
    <>
      <div className="h-full overflow-hidden">
        <div
          className="flex h-full transition-transform duration-300 ease-in-out"
          style={{ width: "300%", transform: `translateX(${panelOffset}%)` }}
        >
          {/* Panel 0 — Connection list */}
          <div className="w-1/3 h-full flex flex-col min-w-0">
            <ConnectionListPanel
              connections={connections}
              loading={loading}
              onConnect={handleConnection}
              onAddClick={() => setScreen("type-picker")}
            />
          </div>

          {/* Panel 1 — Type picker */}
          <div className="w-1/3 h-full flex flex-col min-w-0">
            <TypePickerPanel
              onBack={() => setScreen("list")}
              onSsh={() => setScreen("ssh-form")}
              onWsl={() => setScreen("wsl-picker")}
              onContainer={() => setScreen("container-picker")}
            />
          </div>

          {/* Panel 2 — Detail */}
          <div className="w-1/3 h-full flex flex-col min-w-0">
            {screen === "ssh-form" && (
              <SshFormPanel
                loading={loading}
                onBack={() => setScreen("type-picker")}
                onAdd={(connString) => {
                  setScreen("list");
                  handleNewConnection(connString);
                }}
              />
            )}
            {screen === "wsl-picker" && (
              <WslPickerPanel
                onBack={() => setScreen("type-picker")}
                onAdded={() => setScreen("list")}
              />
            )}
            {screen === "container-picker" && (
              <ContainerPickerPanel
                onBack={() => setScreen("type-picker")}
                onAdded={() => setScreen("list")}
              />
            )}
          </div>
        </div>
      </div>

      <SshAuthModal
        open={showAuthModal}
        username={username}
        savedKeyFiles={savedKeyFiles}
        onSubmit={handleAuthSubmit}
        onCancel={handleAuthCancel}
        loading={loading}
      />
    </>
  );
}

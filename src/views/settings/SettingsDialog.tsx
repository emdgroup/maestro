import { Dialog, DialogContent, DialogTitle } from "@/ui/dialog";
import { SettingsPage } from "@/views/settings/settings-page/SettingsPage";
import { useNavigationActions, useSettingsOpen } from "@/store/navigationStore";
import type { ConnectionKey } from "@/types/bindings";

interface SettingsDialogProps {
  projectId: number;
  connection: ConnectionKey;
}

/**
 * Settings, over whatever the user was looking at.
 *
 * The same shape the picker screen already uses for app-wide settings — the difference is only
 * that a project is open here, so the project and connection groups register too. Keeping the two
 * in one shape is what makes "open settings" mean the same thing from either screen.
 *
 * Open state lives in `navigationStore` rather than here, because the callers that send someone to
 * a settings page (`useExecuteTask`, `useProjectAgentIntro`) are nowhere near this component.
 */
export function SettingsDialog({ projectId, connection }: SettingsDialogProps) {
  const open = useSettingsOpen();
  const { setSettingsOpen } = useNavigationActions();

  return (
    <Dialog open={open} onOpenChange={setSettingsOpen}>
      {/* `top-2` for the close button: the default `top-4` centres it against a 64px header, and
          this one sits in a 48px strip. */}
      <DialogContent className="flex h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl [&>[data-slot=dialog-close]]:top-2">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <div className="min-h-0 flex-1">
          <SettingsPage projectId={projectId} connection={connection} headerPadEnd framed={false} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

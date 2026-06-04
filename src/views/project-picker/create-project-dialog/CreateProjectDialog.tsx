import { useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { FilePicker } from "../file-picker/FilePicker";
import { useCreateNewProject } from "@/services/project.service";
import { useSelectedProjectActions } from "@/store/projectStore";
import { api } from "@/lib/tauri-utils";
import type { SshConnection, WslConnection } from "@/types/bindings";
import { Loader2 } from "lucide-react";

interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection: SshConnection | null;
  wslConnection?: WslConnection | null;
}

export function CreateProjectDialog({ open, onOpenChange, connection, wslConnection }: CreateProjectDialogProps) {
  const [parentDir, setParentDir] = useState("");
  const [folderName, setFolderName] = useState("");
  const [showDirPicker, setShowDirPicker] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { mutateAsync: createNewProject, isPending } = useCreateNewProject();
  const { setSelectedProject } = useSelectedProjectActions();

  const handleBrowse = (selectedPath: string) => {
    setParentDir(selectedPath);
    setShowDirPicker(false);
  };

  const handleSubmit = async () => {
    if (!parentDir.trim() || !folderName.trim()) return;
    setError(null);
    try {
      const created = await createNewProject({
        parentDir: parentDir.trim(),
        folderName: folderName.trim(),
        connectionId: connection?.id ?? null,
        wslConnectionId: wslConnection?.id ?? null,
      });
      const project = await api.openProject(created.id);
      api.primeProjectServer(created.id).catch(() => {
        toast.error("Failed to initialize project server");
      });
      setSelectedProject(project);
      // Reset form and close
      setParentDir("");
      setFolderName("");
      onOpenChange(false);
    } catch (e) {
      // Show inline error (not a toast — per design decision)
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!isPending) {
      if (!nextOpen) {
        setParentDir("");
        setFolderName("");
        setError(null);
      }
      onOpenChange(nextOpen);
    }
  };

  return (
    <>
      <Dialog open={open && !showDirPicker} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create Project</DialogTitle>
            <DialogDescription>Create a new project folder.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="create-parent">Parent Directory</Label>
              <div className="flex gap-2">
                <Input
                  id="create-parent"
                  placeholder="/path/to/parent"
                  value={parentDir}
                  onChange={(e) => {
                    setParentDir(e.target.value);
                    setError(null);
                  }}
                  disabled={isPending}
                  className="flex-1"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowDirPicker(true)}
                  disabled={isPending}
                >
                  Browse
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-folder">Folder Name</Label>
              <Input
                id="create-folder"
                placeholder="my-project"
                value={folderName}
                onChange={(e) => {
                  setFolderName(e.target.value);
                  setError(null);
                }}
                disabled={isPending}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={isPending || !parentDir.trim() || !folderName.trim()}
            >
              {isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Nested FilePicker dialog for browsing parent directory */}
      <Dialog open={showDirPicker} onOpenChange={setShowDirPicker}>
        <DialogContent className="h-150 md:max-w-4xl p-0 flex flex-col [&>button:hover]:text-accent">
          <FilePicker
            connection={connection}
            wslConnection={wslConnection}
            onProjectSelect={(path) => handleBrowse(path)}
            loading={false}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

import { useState } from "react";
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
import { FilePicker } from "@/components/project-picker/FilePicker";
import { useCloneProject } from "@/services/project.service";
import { useSelectedProjectActions } from "@/store/projectStore";
import { api } from "@/lib/tauri-utils";
import type { SshConnection } from "@/types/bindings";
import { Loader2 } from "lucide-react";

interface CloneProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection: SshConnection | null;
}

export function CloneProjectDialog({ open, onOpenChange, connection }: CloneProjectDialogProps) {
  const [url, setUrl] = useState("");
  const [targetPath, setTargetPath] = useState("");
  const [showDirPicker, setShowDirPicker] = useState(false);
  const { mutateAsync: cloneProject, isPending } = useCloneProject();
  const { setSelectedProject } = useSelectedProjectActions();

  const handleBrowse = (selectedPath: string) => {
    // Auto-derive repo name from URL and append to selected parent dir
    const repoName = deriveRepoName(url);
    setTargetPath(repoName ? `${selectedPath}/${repoName}` : selectedPath);
    setShowDirPicker(false);
  };

  const handleSubmit = async () => {
    if (!url.trim() || !targetPath.trim()) return;
    try {
      const created = await cloneProject({
        url: url.trim(),
        targetPath: targetPath.trim(),
        connectionId: connection?.id ?? null,
      });
      const project = await api.openProject(created.id);
      api.primeProjectServer(created.id).catch(() => {});
      setSelectedProject(project);
      // Reset form and close
      setUrl("");
      setTargetPath("");
      onOpenChange(false);
    } catch {
      // Error handled by mutation hook (toast via onError)
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!isPending) {
      if (!nextOpen) {
        setUrl("");
        setTargetPath("");
      }
      onOpenChange(nextOpen);
    }
  };

  return (
    <>
      <Dialog open={open && !showDirPicker} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Clone Project</DialogTitle>
            <DialogDescription>Clone a git repository into a chosen directory.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="clone-target">Parent Directory</Label>
              <div className="flex gap-2">
                <Input
                  id="clone-target"
                  placeholder="/path/to/parent"
                  value={targetPath}
                  onChange={(e) => setTargetPath(e.target.value)}
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
              <Label htmlFor="clone-url">Git URL</Label>
              <Input
                id="clone-url"
                placeholder="https://github.com/user/repo.git"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={isPending}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={isPending || !url.trim() || !targetPath.trim()}
            >
              {isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Cloning...
                </>
              ) : (
                "Clone"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Nested FilePicker dialog for browsing target directory */}
      <Dialog open={showDirPicker} onOpenChange={setShowDirPicker}>
        <DialogContent className="h-150 md:max-w-4xl p-0 flex flex-col [&>button:hover]:text-accent">
          <FilePicker
            connection={connection}
            onProjectSelect={(path) => handleBrowse(path)}
            loading={false}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Derive repo name from a git URL (last path segment without .git suffix) */
function deriveRepoName(url: string): string {
  try {
    const cleaned = url
      .trim()
      .replace(/\/+$/, "")
      .replace(/\.git$/, "");
    const lastSegment = cleaned.split("/").pop() ?? "";
    return lastSegment;
  } catch {
    return "";
  }
}

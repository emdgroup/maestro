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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/ui/tabs";
import { FilePicker } from "@/components/project-picker/FilePicker";
import { ProviderRepoPicker } from "@/components/project-picker/ProviderRepoPicker";
import { useCloneProject } from "@/services/project.service";
import { useSelectedProjectActions } from "@/store/projectStore";
import { api } from "@/lib/tauri-utils";
import type { SshConnection } from "@/types/bindings";
import { Check, Globe, Link, Loader2 } from "lucide-react";

interface CloneProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection: SshConnection | null;
}

export function CloneProjectDialog({ open, onOpenChange, connection }: CloneProjectDialogProps) {
  const [url, setUrl] = useState("");
  const [targetPath, setTargetPath] = useState("");
  const [showDirPicker, setShowDirPicker] = useState(false);
  const [selectedRepoName, setSelectedRepoName] = useState("");
  const [provider, setProvider] = useState<string | null>(null);
  const { mutateAsync: cloneProject, isPending } = useCloneProject();
  const { setSelectedProject } = useSelectedProjectActions();

  const handleBrowse = (selectedPath: string) => {
    const repoName = deriveRepoName(url);
    setTargetPath(repoName ? `${selectedPath}/${repoName}` : selectedPath);
    setShowDirPicker(false);
  };

  const handleRepoSelected = (cloneUrl: string, repoName: string, selectedProvider?: string) => {
    setUrl(cloneUrl);
    setSelectedRepoName(repoName);
    setProvider(selectedProvider ?? null);
    if (targetPath) {
      const parent = targetPath.includes("/")
        ? targetPath.substring(0, targetPath.lastIndexOf("/"))
        : targetPath;
      setTargetPath(`${parent}/${repoName}`);
    }
  };

  const handleSubmit = async () => {
    if (!url.trim() || !targetPath.trim()) return;
    try {
      const created = await cloneProject({
        url: url.trim(),
        targetPath: targetPath.trim(),
        connectionId: connection?.id ?? null,
        provider: provider ?? null,
      });
      const project = await api.openProject(created.id);
      api.primeProjectServer(created.id).catch(() => {});
      setSelectedProject(project);
      setUrl("");
      setTargetPath("");
      setSelectedRepoName("");
      setProvider(null);
      onOpenChange(false);
    } catch {
      // Error handled by mutation hook
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!isPending) {
      if (!nextOpen) {
        setUrl("");
        setTargetPath("");
        setSelectedRepoName("");
        setProvider(null);
      }
      onOpenChange(nextOpen);
    }
  };

  return (
    <>
      <Dialog open={open && !showDirPicker} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Clone Project</DialogTitle>
            <DialogDescription>Clone a git repository into a chosen directory.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {/* Parent directory — always visible */}
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

            {/* Tabs: Provider first, URL second */}
            <Tabs defaultValue="provider">
              <TabsList className="w-full">
                <TabsTrigger value="provider">
                  <Globe className="size-3.5" />
                  Provider
                </TabsTrigger>
                <TabsTrigger value="url">
                  <Link className="size-3.5" />
                  URL
                </TabsTrigger>
              </TabsList>

              <TabsContent value="provider">
                <ProviderRepoPicker onRepoSelected={handleRepoSelected} disabled={isPending} />
                {selectedRepoName && url && (
                  <div className="flex items-center gap-2 mt-3 p-2.5 rounded-md border border-success/30 bg-success/5 text-sm">
                    <Check className="size-4 text-success shrink-0" />
                    <div className="flex-1 min-w-0">
                      <span className="font-medium">{selectedRepoName}</span>
                      <span className="text-muted-foreground text-xs block truncate">{url}</span>
                    </div>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="url">
                <div className="space-y-2">
                  <Label htmlFor="clone-url">Git URL</Label>
                  <Input
                    id="clone-url"
                    placeholder="https://github.com/user/repo.git"
                    value={url}
                    onChange={(e) => {
                      setUrl(e.target.value);
                      setSelectedRepoName("");
                    }}
                    disabled={isPending}
                  />
                </div>
              </TabsContent>
            </Tabs>
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

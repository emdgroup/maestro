import { useState, useRef } from "react";
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/ui/tabs";
import { FilePicker } from "../file-picker/FilePicker";
import { ProviderRepoPicker } from "../provider-repo-picker/ProviderRepoPicker";
import { useCloneProject } from "@/services/project.service";
import { useSelectedProjectActions, applyProjectStartupTab } from "@/store/projectStore";
import { api } from "@/lib/tauri-utils";
import type { SshConnection, WslConnection } from "@/types/bindings";
import { Check, Globe, Link, Loader2 } from "lucide-react";

interface CloneProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection: SshConnection | null;
  wslConnection?: WslConnection | null;
}

export function CloneProjectDialog({
  open,
  onOpenChange,
  connection,
  wslConnection,
}: CloneProjectDialogProps) {
  const [url, setUrl] = useState("");
  const [targetPath, setTargetPath] = useState("");
  const [showDirPicker, setShowDirPicker] = useState(false);
  const [selectedRepoName, setSelectedRepoName] = useState("");
  const [provider, setProvider] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("provider");
  const [attempted, setAttempted] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { mutateAsync: cloneProject, isPending } = useCloneProject();
  const { setSelectedProject } = useSelectedProjectActions();

  const isSubmitDisabled = isPending || !url.trim() || !targetPath.trim();

  const triggerValidation = () => {
    const el = formRef.current;
    if (el) {
      el.classList.remove("animate-shake");
      void el.offsetWidth;
      el.classList.add("animate-shake");
    }
    setAttempted(true);
    if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current);
    shakeTimerRef.current = setTimeout(() => setAttempted(false), 2000);
  };

  const startHoverTimer = () => {
    if (!isSubmitDisabled) return;
    hoverTimerRef.current = setTimeout(triggerValidation, 500);
  };

  const cancelHoverTimer = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };

  const handleBrowse = (selectedPath: string) => {
    const repoName = deriveRepoName(url);
    const normalized = selectedPath.replace(/\/+$/, "");
    setTargetPath(repoName ? `${normalized}/${repoName}` : normalized);
    setShowDirPicker(false);
  };

  const handleRepoSelected = (cloneUrl: string, repoName: string, selectedProvider?: string) => {
    setUrl(cloneUrl);
    setProvider(selectedProvider ?? null);
    if (targetPath) {
      // If a repo name was previously appended, strip it before appending the new one.
      // If targetPath is a pure parent dir (no repo appended yet), append directly.
      const parent = selectedRepoName
        ? targetPath.substring(0, targetPath.lastIndexOf("/"))
        : targetPath.replace(/\/+$/, "");
      setTargetPath(`${parent}/${repoName}`);
    }
    setSelectedRepoName(repoName);
  };

  const handleSubmit = async () => {
    if (!url.trim() || !targetPath.trim()) return;
    try {
      const created = await cloneProject({
        url: url.trim(),
        targetPath: targetPath.trim(),
        connectionId: connection?.id ?? null,
        wslConnectionId: wslConnection?.id ?? null,
        provider: provider ?? null,
      });
      const project = await api.openProject(created.id);
      await Promise.all([
        api.primeProjectServer(created.id).catch(() => {
          toast.error("Failed to initialize project server");
        }),
        applyProjectStartupTab(project.id),
      ]);
      setSelectedProject(project);
      setAttempted(false);
      cancelHoverTimer();
      if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current);
      setUrl("");
      setTargetPath("");
      setSelectedRepoName("");
      setActiveTab("provider");
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
        setActiveTab("provider");
        setAttempted(false);
        cancelHoverTimer();
        if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current);
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
          <div ref={formRef} className="space-y-4 py-2">
            {/* Parent directory — always visible */}
            <div className="space-y-2">
              <Label htmlFor="clone-target" required>
                Parent Directory
              </Label>
              <div className="flex gap-2">
                <Input
                  id="clone-target"
                  placeholder="/path/to/parent"
                  value={targetPath}
                  onChange={(e) => setTargetPath(e.target.value)}
                  disabled={isPending}
                  className="flex-1"
                  aria-required="true"
                  aria-invalid={attempted && !targetPath.trim() ? "true" : undefined}
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
            <Tabs value={activeTab} onValueChange={setActiveTab}>
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
                  <Label htmlFor="clone-url" required>
                    Git URL
                  </Label>
                  <Input
                    id="clone-url"
                    placeholder="https://github.com/user/repo.git"
                    value={url}
                    onChange={(e) => {
                      setUrl(e.target.value);
                      setSelectedRepoName("");
                    }}
                    disabled={isPending}
                    aria-required="true"
                    aria-invalid={attempted && !url.trim() ? "true" : undefined}
                  />
                  {attempted && !url.trim() && (
                    <p className="text-xs text-destructive">Git URL is required</p>
                  )}
                </div>
              </TabsContent>
            </Tabs>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isPending}>
              Cancel
            </Button>
            <div onMouseEnter={startHoverTimer} onMouseLeave={cancelHoverTimer}>
              <Button onClick={handleSubmit} disabled={isSubmitDisabled}>
                {isPending ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Cloning...
                  </>
                ) : (
                  "Clone"
                )}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

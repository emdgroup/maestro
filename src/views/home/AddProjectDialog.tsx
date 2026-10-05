import { useState } from "react";
import { FolderOpen, GitFork, Globe, Link, Plus } from "lucide-react";
import { Dialog, DialogContent } from "@/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";
import { cn } from "@/lib/utils";
import {
  useDockerHome,
  useGetDefaultFilePickerPath,
  useWslHome,
} from "@/services/connection.service";
import { useCloneProject, useCreateNewProject } from "@/services/project.service";
import { FilePicker } from "@/views/project-picker/file-picker/FilePicker";
import { ProviderRepoPicker } from "@/views/project-picker/provider-repo-picker/ProviderRepoPicker";
import { deriveRepoName } from "@/views/project-picker/clone-project-dialog/CloneProjectDialog";
import type { HomeConnection } from "./ConnectionPanel";
import { HomeSheet } from "./HomeSheet";

type Choice = "open" | "clone" | "create";

const CHOICES: { choice: Choice; title: string; line: string; Icon: typeof Plus }[] = [
  {
    choice: "open",
    title: "Open a folder",
    line: "A repository already on this machine",
    Icon: FolderOpen,
  },
  { choice: "clone", title: "Clone", line: "From GitHub or any git URL", Icon: GitFork },
  { choice: "create", title: "Start fresh", line: "A new, empty repository", Icon: Plus },
];

const BUTTON =
  "h-9 shrink-0 cursor-pointer rounded-xl bg-primary px-4 text-xs text-primary-foreground disabled:opacity-50";
const FIELD = "home-field h-9 rounded-xl px-3 font-mono text-xs";

/** The connection's home folder, where a new project starts out. */
function useHomeFolder(connection: HomeConnection) {
  const key = connection.key;
  const local = useGetDefaultFilePickerPath();
  const wsl = useWslHome(key.type === "wsl" ? (connection.wsl?.distro_name ?? "") : "");
  const docker = useDockerHome(
    key.type === "docker" ? (connection.docker?.container_name ?? "") : "",
  );
  if (key.type === "local") return local.data ?? null;
  if (key.type === "ssh") return connection.ssh ? `/home/${connection.ssh.username}` : null;
  if (key.type === "wsl") return wsl.data ?? null;
  return docker.data ?? null;
}

interface AddProjectDialogProps {
  connection: HomeConnection | null;
  onClose: () => void;
  /** Opens a folder through Home's shared open flow, which registers it first. */
  onOpenPath: (path: string) => Promise<void>;
  /** Opens a project this app has just registered (cloned or created). */
  onOpenProject: (projectId: number) => Promise<void>;
}

/** Add a project to a connection: open a folder already there, clone one, or start a new one. */
export function AddProjectDialog({
  connection,
  onClose,
  onOpenPath,
  onOpenProject,
}: AddProjectDialogProps) {
  if (!connection) return null;
  return (
    <AddProjectSheet
      connection={connection}
      onClose={onClose}
      onOpenPath={onOpenPath}
      onOpenProject={onOpenProject}
    />
  );
}

function AddProjectSheet({
  connection,
  onClose,
  onOpenPath,
  onOpenProject,
}: AddProjectDialogProps & { connection: HomeConnection }) {
  const home = useHomeFolder(connection);
  const sep = home?.includes("\\") ? "\\" : "/";
  const [choice, setChoice] = useState<Choice | null>(null);
  // Both start at the home folder, which may still be loading, until the user types.
  const [folderTyped, setFolder] = useState<string | null>(null);
  const [intoTyped, setInto] = useState<string | null>(null);
  const folder = folderTyped ?? (home ? home + sep : "");
  const into = intoTyped ?? home ?? "";
  const [url, setUrl] = useState("");
  const [cloneTab, setCloneTab] = useState("provider");
  const [provider, setProvider] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [browsing, setBrowsing] = useState<"folder" | "into" | null>(null);
  const [busy, setBusy] = useState(false);
  const { mutateAsync: cloneProject } = useCloneProject();
  const { mutateAsync: createProject } = useCreateNewProject();

  const ids = {
    connectionId: connection.key.type === "ssh" ? connection.key.id : null,
    wslConnectionId: connection.key.type === "wsl" ? connection.key.id : null,
    dockerConnectionId: connection.key.type === "docker" ? connection.key.id : null,
  };

  const finish = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
      onClose();
    } catch {
      // The mutations report their own failures.
    } finally {
      setBusy(false);
    }
  };

  const repoName = deriveRepoName(url);

  return (
    <>
      <HomeSheet
        open
        onOpenChange={(open) => !open && onClose()}
        eyebrow={`On ${connection.name}`}
        title="Add a project"
        className="sm:max-w-[620px]"
      >
        <div className="mt-5 grid grid-cols-3 gap-3">
          {CHOICES.map(({ choice: option, title, line, Icon }) => (
            <button
              key={option}
              type="button"
              data-selected={choice === option}
              onClick={() => setChoice(option)}
              className="home-pane cursor-pointer rounded-2xl p-4 text-left"
            >
              <Icon className="size-[22px]" strokeWidth={1.6} />
              <div className="mt-3 font-medium">{title}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{line}</div>
            </button>
          ))}
        </div>
        <div className="mt-4">
          {choice === "open" && (
            <div className="flex gap-2">
              <input
                aria-label="Folder"
                value={folder}
                onChange={(event) => setFolder(event.target.value)}
                className={cn(FIELD, "flex-1")}
              />
              <button
                type="button"
                onClick={() => setBrowsing("folder")}
                className="home-pill h-9 cursor-pointer rounded-xl px-3 text-xs"
              >
                Browse…
              </button>
              <button
                type="button"
                disabled={busy || !folder.trim()}
                onClick={() => void finish(() => onOpenPath(folder.trim()))}
                className={BUTTON}
              >
                Open
              </button>
            </div>
          )}
          {choice === "clone" && (
            <div className="space-y-2">
              <Tabs value={cloneTab} onValueChange={setCloneTab}>
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
                  <ProviderRepoPicker
                    disabled={busy}
                    onRepoSelected={(cloneUrl, _name, selected) => {
                      setUrl(cloneUrl);
                      setProvider(selected ?? null);
                    }}
                  />
                  {provider && url && (
                    <div className="mt-2 truncate font-mono text-[11px] text-muted-foreground">
                      {url}
                    </div>
                  )}
                </TabsContent>
                <TabsContent value="url">
                  <input
                    aria-label="Repository URL"
                    autoFocus
                    value={url}
                    onChange={(event) => {
                      setUrl(event.target.value);
                      setProvider(null);
                    }}
                    placeholder="github.com/owner/repo or any git URL"
                    className={cn(FIELD, "w-full")}
                  />
                </TabsContent>
              </Tabs>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-muted-foreground">Into</span>
                <input
                  aria-label="Into"
                  value={into}
                  onChange={(event) => setInto(event.target.value)}
                  className={cn(FIELD, "flex-1")}
                />
                <button
                  type="button"
                  disabled={busy || !repoName || !into.trim()}
                  onClick={() =>
                    void finish(async () => {
                      const created = await cloneProject({
                        url: url.trim(),
                        targetPath: `${into.trim().replace(/[\\/]+$/, "")}${sep}${repoName}`,
                        ...ids,
                        provider,
                      });
                      await onOpenProject(created.id);
                    })
                  }
                  className={BUTTON}
                >
                  Clone
                </button>
              </div>
            </div>
          )}
          {choice === "create" && (
            <div className="flex items-center gap-2">
              <input
                aria-label="Project name"
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Project name"
                className="home-field h-9 w-48 rounded-xl px-3 text-xs"
              />
              <span className="text-[11px] text-muted-foreground">in</span>
              <input
                aria-label="In folder"
                value={into}
                onChange={(event) => setInto(event.target.value)}
                className={cn(FIELD, "flex-1")}
              />
              <button
                type="button"
                disabled={busy || !name.trim() || !into.trim()}
                onClick={() =>
                  void finish(async () => {
                    const created = await createProject({
                      parentDir: into.trim(),
                      folderName: name.trim(),
                      ...ids,
                    });
                    await onOpenProject(created.id);
                  })
                }
                className={BUTTON}
              >
                Create
              </button>
            </div>
          )}
        </div>
      </HomeSheet>

      <Dialog open={browsing !== null} onOpenChange={(open) => !open && setBrowsing(null)}>
        <DialogContent className="flex h-150 flex-col p-0 md:max-w-4xl">
          <FilePicker
            connection={connection.ssh}
            wslConnection={connection.wsl}
            dockerConnection={connection.docker}
            onProjectSelect={(path) => {
              if (browsing === "folder") setFolder(path);
              else setInto(path);
              setBrowsing(null);
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

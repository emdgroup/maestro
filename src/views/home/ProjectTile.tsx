import { Loader2, Lock, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";

/** What a tile shows about one project, from its connection's summary. */
export interface ProjectCard {
  /** This app's id; null for a project only its server knows yet. */
  projectId: number | null;
  path: string;
  name: string;
  working: number;
  review: number;
  queued: number;
  needsYou: boolean;
  blockingPrompt: string | null;
  runningAutomation: string | null;
  /** The machine holding the project, when it is not this window. */
  holder: string | null;
}

type Status = { label: string; className: string; rank: number };

/** The status word, and the order the minimized chips sort by. */
export function projectStatus(project: ProjectCard): Status {
  if (project.needsYou)
    return { label: "Needs you", className: "text-amber-600 dark:text-amber-400", rank: 0 };
  if (project.working > 0) return { label: "Working", className: "home-working", rank: 1 };
  if (project.queued > 0 || project.review > 0)
    return { label: "Idle", className: "text-muted-foreground", rank: 2 };
  return { label: "Quiet", className: "text-muted-foreground/60", rank: 3 };
}

/** Marks a project another window or machine holds. */
export function HeldLock({ holder }: { holder: string }) {
  return (
    <Lock
      role="img"
      aria-label={`Open on ${holder}`}
      className="size-3 shrink-0 text-muted-foreground"
    />
  );
}

/** `/home/billy/src/x` as `~/src/x`, `C:\Users\billy\src\x` as `~\src\x`. */
export function displayPath(path: string) {
  return path.replace(
    /^(\/home\/[^/]+|\/Users\/[^/]+|\/root|[A-Za-z]:[\\/]Users[\\/][^\\/]+)(?=[\\/]|$)/,
    "~",
  );
}

function Count({ value, label, className }: { value: number; label: string; className?: string }) {
  return (
    <span className="flex items-baseline gap-1">
      <span
        className={cn(
          "text-base font-semibold tabular-nums",
          value ? className : "text-muted-foreground/50",
        )}
      >
        {value}
      </span>
      <span className="text-[11px] text-muted-foreground">{label}</span>
    </span>
  );
}

interface TileProps {
  project: ProjectCard;
  opening: boolean;
  onOpen: () => void;
  onRemove: () => void;
}

export function ProjectTile({ project, opening, onOpen, onRemove }: TileProps) {
  const status = projectStatus(project);
  const context = project.blockingPrompt ? (
    <span className="text-amber-600 dark:text-amber-400">{project.blockingPrompt}</span>
  ) : project.runningAutomation ? (
    `${project.runningAutomation} running`
  ) : project.holder ? (
    `Open on ${project.holder}`
  ) : null;
  return (
    // The remove button sits over the status word rather than inside the tile, which is a button.
    // The pane, and its hover lift, is on the wrapper so the two move together.
    <div
      data-attention={project.needsYou}
      data-home-project={project.path}
      className="group/tile home-pane relative flex rounded-2xl"
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-h-[132px] w-full cursor-pointer flex-col rounded-2xl p-4 text-left"
      >
        <div className="flex w-full items-start gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[17px] font-semibold tracking-[-0.025em]">
              <span className="truncate">{project.name}</span>
              {project.holder && <HeldLock holder={project.holder} />}
            </div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">
              {displayPath(project.path)}
            </div>
          </div>
          <span
            className={cn(
              "ml-auto shrink-0 text-[11px] font-medium",
              !opening && "group-focus-within/tile:invisible group-hover/tile:invisible",
              status.className,
              status.rank === 1 && "animate-pulse",
            )}
          >
            {opening ? <Loader2 className="size-3.5 animate-spin" /> : status.label}
          </span>
        </div>
        <div className="mt-2 h-4 w-full truncate text-xs text-muted-foreground">{context}</div>
        <div className="mt-auto flex gap-4 pt-3">
          <Count value={project.working} label="working" className="home-working" />
          <Count value={project.review} label="review" className="home-review" />
          <Count value={project.queued} label="queued" />
        </div>
      </button>
      {!opening && (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={onRemove}
                aria-label={`Remove ${project.name} from Home`}
                className="invisible absolute top-3 right-3 grid size-6 cursor-pointer place-items-center rounded-full text-muted-foreground group-focus-within/tile:visible group-hover/tile:visible hover:bg-foreground/10 hover:text-foreground"
              />
            }
          >
            <X className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>
            <p className="text-xs">Remove from Home</p>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

export function ProjectChip({ project, onOpen }: { project: ProjectCard; onOpen: () => void }) {
  const status = projectStatus(project);
  return (
    <button
      type="button"
      onClick={onOpen}
      data-attention={project.needsYou}
      data-home-project={project.path}
      className="home-pane flex shrink-0 cursor-pointer items-center gap-2 rounded-full py-1 pr-2.5 pl-3 text-xs"
    >
      <span className="font-medium">{project.name}</span>
      {project.holder && <HeldLock holder={project.holder} />}
      <span className={cn("text-[11px]", status.className)}>{status.label}</span>
    </button>
  );
}

export function AddProjectTile({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="home-ghost flex min-h-[132px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-2xl text-muted-foreground"
    >
      <Plus className="size-5" strokeWidth={1.5} />
      <span className="text-xs">Add project</span>
    </button>
  );
}

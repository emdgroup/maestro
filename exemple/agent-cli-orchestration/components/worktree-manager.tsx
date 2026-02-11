"use client"

import {
  GitBranch,
  GitCommit,
  FolderOpen,
  Bot,
  Plus,
  MoreHorizontal,
  RefreshCw,
  AlertTriangle,
  Check,
  FileWarning,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { MOCK_WORKTREES, MOCK_AGENTS, type Worktree } from "@/lib/store"

const STATUS_INDICATOR = {
  clean: {
    icon: Check,
    label: "Clean",
    className: "text-[hsl(var(--primary))]",
    bg: "bg-[hsl(var(--primary))]/10",
  },
  dirty: {
    icon: FileWarning,
    label: "Uncommitted changes",
    className: "text-[hsl(var(--warning))]",
    bg: "bg-[hsl(var(--warning))]/10",
  },
  conflict: {
    icon: AlertTriangle,
    label: "Merge conflicts",
    className: "text-[hsl(var(--destructive))]",
    bg: "bg-[hsl(var(--destructive))]/10",
  },
}

function WorktreeCard({ worktree }: { worktree: Worktree }) {
  const statusInfo = STATUS_INDICATOR[worktree.status]
  const StatusIcon = statusInfo.icon
  const agent = worktree.linkedAgent
    ? MOCK_AGENTS.find((a) => a.id === worktree.linkedAgent)
    : null

  const timeAgo = (dateStr: string) => {
    const diff = Date.now() - new Date(dateStr).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 60) return `${mins}m ago`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h ago`
    return `${Math.floor(hours / 24)}d ago`
  }

  return (
    <div className="group rounded-lg border bg-card p-4 transition-colors hover:border-muted-foreground/30">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2.5">
          <GitBranch className="h-4 w-4 text-[hsl(var(--info))]" />
          <div>
            <span className="font-mono text-sm font-semibold text-foreground">
              {worktree.branch}
            </span>
            <div className="mt-0.5 flex items-center gap-1">
              <StatusIcon className={cn("h-3 w-3", statusInfo.className)} />
              <span className={cn("text-[10px] font-medium", statusInfo.className)}>
                {statusInfo.label}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
            <RefreshCw className="h-3 w-3 text-muted-foreground" />
          </Button>
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
            <MoreHorizontal className="h-3 w-3 text-muted-foreground" />
          </Button>
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <FolderOpen className="h-3 w-3 shrink-0" />
          <span className="font-mono truncate">{worktree.path}</span>
        </div>

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <GitCommit className="h-3 w-3 shrink-0" />
          <span className="font-mono">{worktree.lastCommit}</span>
          <span className="truncate">{worktree.lastCommitMessage}</span>
          <span className="ml-auto shrink-0 text-[10px]">
            {timeAgo(worktree.lastCommitTime)}
          </span>
        </div>
      </div>

      {agent && (
        <div className="mt-3 flex items-center gap-2 rounded-md bg-secondary px-2.5 py-1.5">
          <Bot className="h-3 w-3 text-[hsl(var(--primary))]" />
          <span className="font-mono text-[10px] font-medium text-muted-foreground">
            {agent.name}
          </span>
          <div
            className={cn(
              "ml-auto h-1.5 w-1.5 rounded-full",
              agent.status === "running"
                ? "bg-[hsl(var(--primary))] animate-pulse"
                : "bg-muted-foreground/40"
            )}
          />
          <span className="text-[10px] text-muted-foreground capitalize">
            {agent.status}
          </span>
        </div>
      )}
    </div>
  )
}

export function WorktreeManager() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-foreground">Git Worktrees</h2>
          <Badge
            variant="secondary"
            className="text-[10px] font-medium text-muted-foreground"
          >
            {MOCK_WORKTREES.length} worktrees
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs bg-transparent">
            <RefreshCw className="h-3 w-3" />
            Refresh
          </Button>
          <Button size="sm" className="h-7 gap-1.5 text-xs">
            <Plus className="h-3 w-3" />
            New Worktree
          </Button>
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="grid gap-3 p-4 md:grid-cols-2">
          {MOCK_WORKTREES.map((wt) => (
            <WorktreeCard key={wt.id} worktree={wt} />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

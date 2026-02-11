"use client"

import React from "react"

import { useState } from "react"
import {
  LayoutDashboard,
  GitBranch,
  Bot,
  Settings,
  Terminal,
  Plus,
  FolderOpen,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { KanbanBoard } from "@/components/kanban-board"
import { AgentMonitor } from "@/components/agent-monitor"
import { WorktreeManager } from "@/components/worktree-manager"
import { ProjectSettingsPanel } from "@/components/project-settings"

type View = "kanban" | "agents" | "worktrees" | "settings"

const NAV_ITEMS: { id: View; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "kanban", label: "Tasks", icon: LayoutDashboard },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "worktrees", label: "Worktrees", icon: GitBranch },
  { id: "settings", label: "Settings", icon: Settings },
]

export function AppShell() {
  const [activeView, setActiveView] = useState<View>("kanban")
  const [selectedProject, setSelectedProject] = useState("myapp")

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* Top Bar */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-[hsl(var(--primary))]" />
            <span className="text-sm font-semibold tracking-tight text-foreground">
              AgentOps
            </span>
          </div>
          <div className="h-4 w-px bg-border" />
          <Select value={selectedProject} onValueChange={setSelectedProject}>
            <SelectTrigger className="h-7 w-[160px] border-none bg-secondary text-xs">
              <FolderOpen className="mr-1.5 h-3 w-3 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="myapp">myapp</SelectItem>
              <SelectItem value="api-service">api-service</SelectItem>
              <SelectItem value="docs-site">docs-site</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <nav className="flex items-center gap-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                onClick={() => setActiveView(item.id)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  activeView === item.id
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{item.label}</span>
              </button>
            )
          })}
        </nav>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-md bg-secondary px-2 py-1">
            <div className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--primary))] animate-pulse" />
            <span className="text-xs text-muted-foreground">
              2 agents running
            </span>
          </div>
          <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs bg-transparent">
            <Plus className="h-3 w-3" />
            New Agent
          </Button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 overflow-hidden">
        {activeView === "kanban" && <KanbanBoard />}
        {activeView === "agents" && <AgentMonitor />}
        {activeView === "worktrees" && <WorktreeManager />}
        {activeView === "settings" && <ProjectSettingsPanel />}
      </main>
    </div>
  )
}

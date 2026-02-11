"use client"

import React from "react"

import { useState } from "react"
import {
  FolderOpen,
  Bot,
  Shield,
  FileText,
  Save,
  RotateCcw,
  X,
  Plus,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { MOCK_SETTINGS, type ProjectSettings } from "@/lib/store"

function SettingsSection({
  title,
  description,
  icon: Icon,
  children,
}: {
  title: string
  description: string
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
}) {
  return (
    <div className="rounded-lg border bg-card p-5">
      <div className="flex items-center gap-2.5 mb-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-secondary">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="flex flex-col gap-4">{children}</div>
    </div>
  )
}

function SettingsField({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-8">
      <div className="shrink-0">
        <Label className="text-sm text-foreground">{label}</Label>
        {description && (
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="w-full max-w-xs">{children}</div>
    </div>
  )
}

export function ProjectSettingsPanel() {
  const [settings, setSettings] = useState<ProjectSettings>(MOCK_SETTINGS)
  const [newTool, setNewTool] = useState("")

  const handleRemoveTool = (tool: string) => {
    setSettings((prev) => ({
      ...prev,
      allowedTools: prev.allowedTools.filter((t) => t !== tool),
    }))
  }

  const handleAddTool = () => {
    if (newTool && !settings.allowedTools.includes(newTool)) {
      setSettings((prev) => ({
        ...prev,
        allowedTools: [...prev.allowedTools, newTool],
      }))
      setNewTool("")
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-foreground">
            Project Settings
          </h2>
          <Badge
            variant="secondary"
            className="font-mono text-[10px] font-medium text-muted-foreground"
          >
            {settings.name}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs bg-transparent">
            <RotateCcw className="h-3 w-3" />
            Reset
          </Button>
          <Button size="sm" className="h-7 gap-1.5 text-xs">
            <Save className="h-3 w-3" />
            Save Changes
          </Button>
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-2xl flex flex-col gap-4 p-4">
          {/* General */}
          <SettingsSection
            title="General"
            description="Basic project configuration"
            icon={FolderOpen}
          >
            <SettingsField label="Project Name" description="Used as identifier">
              <Input
                className="h-8 text-sm"
                value={settings.name}
                onChange={(e) =>
                  setSettings((prev) => ({ ...prev, name: e.target.value }))
                }
              />
            </SettingsField>
            <SettingsField label="Root Path" description="Absolute project path">
              <Input
                className="h-8 font-mono text-xs"
                value={settings.rootPath}
                onChange={(e) =>
                  setSettings((prev) => ({ ...prev, rootPath: e.target.value }))
                }
              />
            </SettingsField>
          </SettingsSection>

          {/* Agent Configuration */}
          <SettingsSection
            title="Agent Configuration"
            description="Control agent behavior and resources"
            icon={Bot}
          >
            <SettingsField label="Default Model" description="LLM model for new agents">
              <Select
                value={settings.model}
                onValueChange={(v) =>
                  setSettings((prev) => ({ ...prev, model: v }))
                }
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="claude-sonnet-4">Claude Sonnet 4</SelectItem>
                  <SelectItem value="claude-opus-4">Claude Opus 4</SelectItem>
                  <SelectItem value="o3">OpenAI o3</SelectItem>
                  <SelectItem value="gpt-4.1">GPT-4.1</SelectItem>
                  <SelectItem value="gemini-2.5-pro">Gemini 2.5 Pro</SelectItem>
                </SelectContent>
              </Select>
            </SettingsField>
            <SettingsField
              label="Max Concurrent Agents"
              description="Limit parallel agent execution"
            >
              <Select
                value={String(settings.maxConcurrentAgents)}
                onValueChange={(v) =>
                  setSettings((prev) => ({
                    ...prev,
                    maxConcurrentAgents: Number(v),
                  }))
                }
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4, 6, 8].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n} agent{n > 1 ? "s" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsField>
            <SettingsField
              label="Auto-create Worktree"
              description="Create a git worktree per agent task"
            >
              <div className="flex justify-end">
                <Switch
                  checked={settings.autoCreateWorktree}
                  onCheckedChange={(v) =>
                    setSettings((prev) => ({ ...prev, autoCreateWorktree: v }))
                  }
                />
              </div>
            </SettingsField>
          </SettingsSection>

          {/* Allowed Tools */}
          <SettingsSection
            title="Allowed Tools"
            description="Tools the agent is permitted to use"
            icon={Shield}
          >
            <div className="flex flex-wrap gap-1.5">
              {settings.allowedTools.map((tool) => (
                <span
                  key={tool}
                  className="group inline-flex items-center gap-1 rounded-md border bg-secondary px-2 py-1 font-mono text-xs text-secondary-foreground"
                >
                  {tool}
                  <button
                    onClick={() => handleRemoveTool(tool)}
                    className="text-muted-foreground/60 transition-colors hover:text-[hsl(var(--destructive))]"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <Input
                className="h-8 font-mono text-xs"
                placeholder="Add tool name..."
                value={newTool}
                onChange={(e) => setNewTool(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddTool()}
              />
              <Button
                variant="outline"
                size="sm"
                className="h-8 shrink-0 bg-transparent"
                onClick={handleAddTool}
              >
                <Plus className="h-3 w-3" />
              </Button>
            </div>
          </SettingsSection>

          {/* Custom Instructions */}
          <SettingsSection
            title="Custom Instructions"
            description="Additional context for agents on this project"
            icon={FileText}
          >
            <textarea
              className="w-full rounded-md border bg-secondary px-3 py-2 font-mono text-xs text-secondary-foreground leading-relaxed focus:outline-none focus:ring-1 focus:ring-ring resize-y min-h-[100px]"
              style={{ minHeight: "100px" }}
              rows={4}
              value={settings.customInstructions}
              onChange={(e) =>
                setSettings((prev) => ({
                  ...prev,
                  customInstructions: e.target.value,
                }))
              }
            />
          </SettingsSection>
        </div>
      </ScrollArea>
    </div>
  )
}

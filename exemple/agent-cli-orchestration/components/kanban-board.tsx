"use client"

import React from "react"

import { useState, useCallback } from "react"
import {
  GripVertical,
  Plus,
  MoreHorizontal,
  AlertCircle,
  ArrowUp,
  ArrowDown,
  Minus,
  Bot,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  type Task,
  type TaskStatus,
  KANBAN_COLUMNS,
  MOCK_TASKS,
  MOCK_AGENTS,
} from "@/lib/store"

const PRIORITY_CONFIG = {
  critical: { icon: AlertCircle, className: "text-[hsl(var(--destructive))]" },
  high: { icon: ArrowUp, className: "text-[hsl(var(--warning))]" },
  medium: { icon: Minus, className: "text-muted-foreground" },
  low: { icon: ArrowDown, className: "text-muted-foreground/60" },
}

const COLUMN_ACCENT: Record<TaskStatus, string> = {
  backlog: "bg-muted-foreground/40",
  ready: "bg-[hsl(var(--info))]",
  "in-progress": "bg-[hsl(var(--primary))]",
  verification: "bg-[hsl(var(--warning))]",
  done: "bg-muted-foreground/30",
}

function TaskCard({
  task,
  onDragStart,
}: {
  task: Task
  onDragStart: (e: React.DragEvent, taskId: string) => void
}) {
  const PriorityIcon = PRIORITY_CONFIG[task.priority].icon
  const agent = task.assignedAgent
    ? MOCK_AGENTS.find((a) => a.id === task.assignedAgent)
    : null

  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, task.id)}
      className="group cursor-grab rounded-lg border bg-card p-3 transition-colors hover:border-muted-foreground/30 active:cursor-grabbing"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <GripVertical className="h-3 w-3 text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100" />
          <PriorityIcon
            className={cn("h-3.5 w-3.5", PRIORITY_CONFIG[task.priority].className)}
          />
        </div>
        <button className="text-muted-foreground/40 opacity-0 transition-opacity hover:text-muted-foreground group-hover:opacity-100">
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="mt-1.5 text-sm font-medium leading-snug text-foreground">
        {task.title}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground line-clamp-2">
        {task.description}
      </p>
      <div className="mt-3 flex items-center justify-between">
        <div className="flex flex-wrap gap-1">
          {task.labels.map((label) => (
            <span
              key={label}
              className="inline-flex items-center rounded-md bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
            >
              {label}
            </span>
          ))}
        </div>
        {agent && (
          <div className="flex items-center gap-1 rounded-md bg-secondary px-1.5 py-0.5">
            <Bot className="h-2.5 w-2.5 text-[hsl(var(--primary))]" />
            <span className="text-[10px] font-medium text-muted-foreground">
              {agent.name.split("-").slice(0, 2).join("-")}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

function KanbanColumn({
  column,
  tasks,
  onDragStart,
  onDrop,
  onDragOver,
}: {
  column: { id: TaskStatus; label: string }
  tasks: Task[]
  onDragStart: (e: React.DragEvent, taskId: string) => void
  onDrop: (e: React.DragEvent, status: TaskStatus) => void
  onDragOver: (e: React.DragEvent) => void
}) {
  const [isDragOver, setIsDragOver] = useState(false)

  return (
    <div
      className={cn(
        "flex min-w-[260px] flex-1 flex-col rounded-lg border transition-colors",
        isDragOver ? "border-[hsl(var(--primary))]/30 bg-[hsl(var(--primary))]/5" : "bg-muted/30"
      )}
      onDragOver={(e) => {
        e.preventDefault()
        setIsDragOver(true)
        onDragOver(e)
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={(e) => {
        setIsDragOver(false)
        onDrop(e, column.id)
      }}
    >
      <div className="flex items-center justify-between px-3 py-2.5">
        <div className="flex items-center gap-2">
          <div className={cn("h-2 w-2 rounded-full", COLUMN_ACCENT[column.id])} />
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {column.label}
          </span>
          <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-secondary px-1 text-[10px] font-medium text-muted-foreground">
            {tasks.length}
          </span>
        </div>
        <button className="text-muted-foreground/60 transition-colors hover:text-muted-foreground">
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      <ScrollArea className="flex-1 px-2 pb-2">
        <div className="flex flex-col gap-2">
          {tasks.map((task) => (
            <TaskCard key={task.id} task={task} onDragStart={onDragStart} />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

export function KanbanBoard() {
  const [tasks, setTasks] = useState<Task[]>(MOCK_TASKS)

  const handleDragStart = useCallback((e: React.DragEvent, taskId: string) => {
    e.dataTransfer.setData("text/plain", taskId)
    e.dataTransfer.effectAllowed = "move"
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent, newStatus: TaskStatus) => {
      e.preventDefault()
      const taskId = e.dataTransfer.getData("text/plain")
      setTasks((prev) =>
        prev.map((t) => (t.id === taskId ? { ...t, status: newStatus } : t))
      )
    },
    []
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = "move"
  }, [])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-foreground">Task Board</h2>
          <Badge
            variant="secondary"
            className="text-[10px] font-medium text-muted-foreground"
          >
            {tasks.length} tasks
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-7 text-xs bg-transparent">
            Filter
          </Button>
          <Button size="sm" className="h-7 gap-1 text-xs">
            <Plus className="h-3 w-3" />
            Add Task
          </Button>
        </div>
      </div>
      <div className="flex flex-1 gap-3 overflow-x-auto p-4">
        {KANBAN_COLUMNS.map((column) => (
          <KanbanColumn
            key={column.id}
            column={column}
            tasks={tasks.filter((t) => t.status === column.id)}
            onDragStart={handleDragStart}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
          />
        ))}
      </div>
    </div>
  )
}

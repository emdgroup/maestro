"use client"

import { useState, useRef, useEffect } from "react"
import {
  Bot,
  Play,
  Square,
  Cpu,
  Zap,
  ChevronRight,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  type Agent,
  type LogEntry,
  MOCK_AGENTS,
  MOCK_LOGS,
  MOCK_TASKS,
} from "@/lib/store"

const STATUS_CONFIG = {
  idle: { color: "bg-muted-foreground/40", label: "Idle", textColor: "text-muted-foreground" },
  running: { color: "bg-[hsl(var(--primary))]", label: "Running", textColor: "text-[hsl(var(--primary))]" },
  error: { color: "bg-[hsl(var(--destructive))]", label: "Error", textColor: "text-[hsl(var(--destructive))]" },
  stopped: { color: "bg-muted-foreground/40", label: "Stopped", textColor: "text-muted-foreground" },
}

const LOG_TYPE_STYLES: Record<string, string> = {
  stdout: "text-foreground",
  stderr: "text-[hsl(var(--destructive))]",
  system: "text-[hsl(var(--info))]",
  "tool-call": "text-[hsl(var(--warning))]",
  "tool-result": "text-[hsl(var(--primary))]",
}

const LOG_TYPE_PREFIX: Record<string, string> = {
  stdout: "OUT",
  stderr: "ERR",
  system: "SYS",
  "tool-call": "CALL",
  "tool-result": "RES",
}

function AgentCard({
  agent,
  isSelected,
  onClick,
}: {
  agent: Agent
  isSelected: boolean
  onClick: () => void
}) {
  const status = STATUS_CONFIG[agent.status]
  const task = agent.currentTask
    ? MOCK_TASKS.find((t) => t.id === agent.currentTask)
    : null

  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full flex-col gap-2 rounded-lg border p-3 text-left transition-colors",
        isSelected
          ? "border-[hsl(var(--primary))]/30 bg-[hsl(var(--primary))]/5"
          : "bg-card hover:border-muted-foreground/30"
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bot className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-mono text-xs font-medium text-foreground">
            {agent.name}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <div
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              status.color,
              agent.status === "running" && "animate-pulse"
            )}
          />
          <span className={cn("text-[10px] font-medium", status.textColor)}>
            {status.label}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
        <div className="flex items-center gap-1">
          <Cpu className="h-2.5 w-2.5" />
          <span>{agent.model}</span>
        </div>
        <div className="flex items-center gap-1">
          <Zap className="h-2.5 w-2.5" />
          <span>{(agent.tokensUsed / 1000).toFixed(1)}k tokens</span>
        </div>
      </div>

      {task && (
        <div className="rounded-md bg-secondary px-2 py-1">
          <p className="text-[10px] font-medium text-muted-foreground line-clamp-1">
            {task.title}
          </p>
        </div>
      )}
    </button>
  )
}

function TerminalOutput({
  logs,
  selectedAgentId,
}: {
  logs: LogEntry[]
  selectedAgentId: string | null
}) {
  const scrollRef = useRef<HTMLDivElement>(null)

  const filteredLogs = selectedAgentId
    ? logs.filter((l) => l.agentId === selectedAgentId)
    : logs

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [filteredLogs])

  return (
    <div className="flex flex-1 flex-col overflow-hidden rounded-lg border bg-[hsl(220,16%,5%)]">
      <div className="flex items-center justify-between border-b bg-[hsl(220,14%,8%)] px-3 py-1.5">
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            <div className="h-2 w-2 rounded-full bg-[hsl(var(--destructive))]/60" />
            <div className="h-2 w-2 rounded-full bg-[hsl(var(--warning))]/60" />
            <div className="h-2 w-2 rounded-full bg-[hsl(var(--primary))]/60" />
          </div>
          <span className="font-mono text-[10px] text-muted-foreground">
            {selectedAgentId
              ? `agent:${MOCK_AGENTS.find((a) => a.id === selectedAgentId)?.name}`
              : "all-agents"}
          </span>
        </div>
        <span className="font-mono text-[10px] text-muted-foreground">
          {filteredLogs.length} entries
        </span>
      </div>
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-3 font-mono text-xs leading-relaxed"
      >
        {filteredLogs.map((log) => {
          const time = new Date(log.timestamp).toLocaleTimeString("en-US", {
            hour12: false,
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })
          return (
            <div key={log.id} className="flex gap-2 py-0.5">
              <span className="shrink-0 text-muted-foreground/50">{time}</span>
              <span
                className={cn(
                  "shrink-0 w-10 text-right font-semibold",
                  LOG_TYPE_STYLES[log.type]
                )}
              >
                {LOG_TYPE_PREFIX[log.type]}
              </span>
              <span className={cn("flex-1", LOG_TYPE_STYLES[log.type])}>
                {log.content}
              </span>
            </div>
          )
        })}
        <div className="flex items-center gap-1 py-0.5 text-muted-foreground/30">
          <ChevronRight className="h-3 w-3" />
          <span className="animate-pulse">_</span>
        </div>
      </div>
    </div>
  )
}

export function AgentMonitor() {
  const [selectedAgent, setSelectedAgent] = useState<string | null>("agent-1")

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-foreground">Agent Monitor</h2>
          <Badge
            variant="secondary"
            className="text-[10px] font-medium text-muted-foreground"
          >
            {MOCK_AGENTS.filter((a) => a.status === "running").length} active
          </Badge>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="sm" className="h-7 gap-1 text-xs bg-transparent">
            <Play className="h-3 w-3" />
            Start All
          </Button>
          <Button variant="outline" size="sm" className="h-7 gap-1 text-xs bg-transparent">
            <Square className="h-3 w-3" />
            Stop All
          </Button>
        </div>
      </div>
      <div className="flex flex-1 gap-4 overflow-hidden p-4">
        {/* Agent list */}
        <div className="flex w-72 shrink-0 flex-col gap-2">
          <div className="flex items-center justify-between pb-1">
            <span className="text-xs font-medium text-muted-foreground">Agents</span>
            <button
              onClick={() => setSelectedAgent(null)}
              className={cn(
                "text-[10px] font-medium transition-colors",
                selectedAgent === null
                  ? "text-[hsl(var(--primary))]"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Show All
            </button>
          </div>
          <ScrollArea className="flex-1">
            <div className="flex flex-col gap-2">
              {MOCK_AGENTS.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  isSelected={selectedAgent === agent.id}
                  onClick={() => setSelectedAgent(agent.id)}
                />
              ))}
            </div>
          </ScrollArea>
        </div>

        {/* Terminal output */}
        <TerminalOutput logs={MOCK_LOGS} selectedAgentId={selectedAgent} />
      </div>
    </div>
  )
}

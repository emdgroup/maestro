export type TaskStatus = "backlog" | "ready" | "in-progress" | "verification" | "done"

export interface Task {
  id: string
  title: string
  description: string
  status: TaskStatus
  priority: "low" | "medium" | "high" | "critical"
  assignedAgent?: string
  labels: string[]
  createdAt: string
}

export interface Agent {
  id: string
  name: string
  status: "idle" | "running" | "error" | "stopped"
  currentTask?: string
  model: string
  startedAt?: string
  tokensUsed: number
}

export interface Worktree {
  id: string
  branch: string
  path: string
  status: "clean" | "dirty" | "conflict"
  linkedAgent?: string
  lastCommit: string
  lastCommitMessage: string
  lastCommitTime: string
}

export interface LogEntry {
  id: string
  agentId: string
  timestamp: string
  type: "stdout" | "stderr" | "system" | "tool-call" | "tool-result"
  content: string
}

export interface ProjectSettings {
  id: string
  name: string
  rootPath: string
  model: string
  maxConcurrentAgents: number
  autoCreateWorktree: boolean
  allowedTools: string[]
  customInstructions: string
}

export const KANBAN_COLUMNS: { id: TaskStatus; label: string }[] = [
  { id: "backlog", label: "Backlog" },
  { id: "ready", label: "Ready" },
  { id: "in-progress", label: "In Progress" },
  { id: "verification", label: "Verification" },
  { id: "done", label: "Done" },
]

// Mock data
export const MOCK_TASKS: Task[] = [
  {
    id: "t1",
    title: "Implement user authentication",
    description: "Add JWT-based auth with refresh tokens",
    status: "in-progress",
    priority: "high",
    assignedAgent: "agent-1",
    labels: ["backend", "security"],
    createdAt: "2026-02-05T10:00:00Z",
  },
  {
    id: "t2",
    title: "Design dashboard layout",
    description: "Create responsive dashboard with sidebar navigation",
    status: "done",
    priority: "medium",
    labels: ["frontend", "ui"],
    createdAt: "2026-02-04T08:00:00Z",
  },
  {
    id: "t3",
    title: "Setup CI/CD pipeline",
    description: "Configure GitHub Actions for automated testing and deployment",
    status: "ready",
    priority: "high",
    labels: ["devops"],
    createdAt: "2026-02-05T14:00:00Z",
  },
  {
    id: "t4",
    title: "Add API rate limiting",
    description: "Implement rate limiting middleware using Redis",
    status: "backlog",
    priority: "medium",
    labels: ["backend", "security"],
    createdAt: "2026-02-06T09:00:00Z",
  },
  {
    id: "t5",
    title: "Write E2E tests for checkout",
    description: "Playwright tests for the entire checkout flow",
    status: "verification",
    priority: "critical",
    assignedAgent: "agent-2",
    labels: ["testing"],
    createdAt: "2026-02-05T16:00:00Z",
  },
  {
    id: "t6",
    title: "Optimize image loading",
    description: "Implement lazy loading and WebP conversion",
    status: "backlog",
    priority: "low",
    labels: ["frontend", "performance"],
    createdAt: "2026-02-06T11:00:00Z",
  },
  {
    id: "t7",
    title: "Database migration scripts",
    description: "Create migration for new schema changes",
    status: "ready",
    priority: "high",
    labels: ["backend", "database"],
    createdAt: "2026-02-05T12:00:00Z",
  },
  {
    id: "t8",
    title: "Add WebSocket support",
    description: "Real-time notifications via WebSocket connections",
    status: "backlog",
    priority: "medium",
    labels: ["backend", "realtime"],
    createdAt: "2026-02-06T08:00:00Z",
  },
]

export const MOCK_AGENTS: Agent[] = [
  {
    id: "agent-1",
    name: "claude-agent-01",
    status: "running",
    currentTask: "t1",
    model: "claude-sonnet-4",
    startedAt: "2026-02-06T09:30:00Z",
    tokensUsed: 48230,
  },
  {
    id: "agent-2",
    name: "claude-agent-02",
    status: "running",
    currentTask: "t5",
    model: "claude-sonnet-4",
    startedAt: "2026-02-06T10:15:00Z",
    tokensUsed: 31450,
  },
  {
    id: "agent-3",
    name: "claude-agent-03",
    status: "idle",
    model: "claude-sonnet-4",
    tokensUsed: 0,
  },
  {
    id: "agent-4",
    name: "codex-agent-01",
    status: "error",
    model: "o3",
    startedAt: "2026-02-06T08:00:00Z",
    tokensUsed: 12800,
  },
]

export const MOCK_WORKTREES: Worktree[] = [
  {
    id: "wt-1",
    branch: "feat/user-auth",
    path: "/projects/myapp/.worktrees/feat-user-auth",
    status: "dirty",
    linkedAgent: "agent-1",
    lastCommit: "a3f8c21",
    lastCommitMessage: "Add JWT middleware for route protection",
    lastCommitTime: "2026-02-06T10:45:00Z",
  },
  {
    id: "wt-2",
    branch: "feat/e2e-tests",
    path: "/projects/myapp/.worktrees/feat-e2e-tests",
    status: "clean",
    linkedAgent: "agent-2",
    lastCommit: "b7e2d44",
    lastCommitMessage: "Add checkout flow test suite",
    lastCommitTime: "2026-02-06T11:20:00Z",
  },
  {
    id: "wt-3",
    branch: "main",
    path: "/projects/myapp",
    status: "clean",
    lastCommit: "c1a9e56",
    lastCommitMessage: "Merge: dashboard layout (#42)",
    lastCommitTime: "2026-02-06T08:30:00Z",
  },
  {
    id: "wt-4",
    branch: "fix/rate-limiter",
    path: "/projects/myapp/.worktrees/fix-rate-limiter",
    status: "conflict",
    lastCommit: "d4f1b78",
    lastCommitMessage: "WIP: Redis connection pooling",
    lastCommitTime: "2026-02-05T22:00:00Z",
  },
]

export const MOCK_LOGS: LogEntry[] = [
  { id: "l1", agentId: "agent-1", timestamp: "2026-02-06T10:45:01Z", type: "system", content: "Agent started on task: Implement user authentication" },
  { id: "l2", agentId: "agent-1", timestamp: "2026-02-06T10:45:02Z", type: "tool-call", content: "read_file(path=\"src/middleware/auth.ts\")" },
  { id: "l3", agentId: "agent-1", timestamp: "2026-02-06T10:45:03Z", type: "tool-result", content: "File read successfully (142 lines)" },
  { id: "l4", agentId: "agent-1", timestamp: "2026-02-06T10:45:05Z", type: "stdout", content: "Analyzing existing auth middleware structure..." },
  { id: "l5", agentId: "agent-1", timestamp: "2026-02-06T10:45:08Z", type: "tool-call", content: "edit_file(path=\"src/middleware/auth.ts\", changes=[...])" },
  { id: "l6", agentId: "agent-1", timestamp: "2026-02-06T10:45:09Z", type: "tool-result", content: "File updated successfully" },
  { id: "l7", agentId: "agent-1", timestamp: "2026-02-06T10:45:12Z", type: "stdout", content: "Adding JWT verification with RS256 algorithm support" },
  { id: "l8", agentId: "agent-1", timestamp: "2026-02-06T10:45:15Z", type: "tool-call", content: "run_command(cmd=\"npm test -- --filter auth\")" },
  { id: "l9", agentId: "agent-1", timestamp: "2026-02-06T10:45:20Z", type: "stdout", content: "PASS src/__tests__/auth.test.ts (3 tests passed)" },
  { id: "l10", agentId: "agent-1", timestamp: "2026-02-06T10:45:22Z", type: "system", content: "Committing changes to feat/user-auth" },
  { id: "l11", agentId: "agent-2", timestamp: "2026-02-06T11:00:01Z", type: "system", content: "Agent started on task: Write E2E tests for checkout" },
  { id: "l12", agentId: "agent-2", timestamp: "2026-02-06T11:00:03Z", type: "tool-call", content: "list_files(path=\"tests/e2e/\")" },
  { id: "l13", agentId: "agent-2", timestamp: "2026-02-06T11:00:04Z", type: "tool-result", content: "Found 4 existing test files" },
  { id: "l14", agentId: "agent-2", timestamp: "2026-02-06T11:00:06Z", type: "stdout", content: "Creating Playwright test for checkout flow..." },
  { id: "l15", agentId: "agent-2", timestamp: "2026-02-06T11:00:10Z", type: "tool-call", content: "write_file(path=\"tests/e2e/checkout.spec.ts\")" },
  { id: "l16", agentId: "agent-4", timestamp: "2026-02-06T08:15:00Z", type: "system", content: "Agent started on task: Database migration" },
  { id: "l17", agentId: "agent-4", timestamp: "2026-02-06T08:15:05Z", type: "stderr", content: "Error: Connection refused to database at localhost:5432" },
  { id: "l18", agentId: "agent-4", timestamp: "2026-02-06T08:15:06Z", type: "system", content: "Agent stopped due to error" },
]

export const MOCK_SETTINGS: ProjectSettings = {
  id: "proj-1",
  name: "myapp",
  rootPath: "/projects/myapp",
  model: "claude-sonnet-4",
  maxConcurrentAgents: 4,
  autoCreateWorktree: true,
  allowedTools: [
    "read_file",
    "edit_file",
    "write_file",
    "run_command",
    "list_files",
    "search_files",
    "browser_navigate",
  ],
  customInstructions: "Follow the project's ESLint and Prettier configuration. Write tests for all new features. Use TypeScript strict mode.",
}

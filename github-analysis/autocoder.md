# AutoCoder - GitHub Project Analysis

**Repository:** https://github.com/leonvanzyl/autocoder
**License:** GNU Affero General Public License v3.0
**Stars:** 1,290 | **Forks:** 315
**Last Updated:** February 3, 2026
**Primary Language:** Python

---

## Executive Summary

AutoCoder is a sophisticated autonomous coding agent system powered by the Claude Agent SDK. It enables building complete applications over multiple development sessions using a two-agent architecture pattern. The system combines an AI-driven backend with a React-based web UI for real-time progress monitoring and project management.

---

## Technical Architecture

### System Architecture Overview

AutoCoder implements a multi-layered architecture with clear separation of concerns:

```
┌─────────────────────────────────────────────────────────────┐
│                    React Web UI (ui/)                        │
│  - Real-time project monitoring                              │
│  - Kanban board & dependency graph visualization              │
│  - Terminal integration with PTY support                      │
│  - AI assistant for project Q&A                              │
└─────────────────────────────────────────────────────────────┘
                              ↑
                         WebSocket/REST
                              ↓
┌─────────────────────────────────────────────────────────────┐
│            FastAPI Backend Server (server/)                   │
│  - REST API for projects, features, settings                 │
│  - WebSocket handlers for real-time updates                  │
│  - Process management (agents, terminals, dev servers)       │
│  - Scheduler service for automated agent runs               │
└─────────────────────────────────────────────────────────────┘
                              ↑
                      MCP Server Protocol
                              ↓
┌─────────────────────────────────────────────────────────────┐
│              Claude Agent + MCP Servers                       │
│  - Feature Management MCP Server (feature_mcp.py)            │
│  - Bash command security validation hooks                    │
│  - SQLAlchemy ORM integration (SQLite)                        │
└─────────────────────────────────────────────────────────────┘
                              ↓
        ┌─────────────────────┼─────────────────────┐
        ↓                     ↓                     ↓
   Generated            Project          Database
   Application         Registry        (features.db)
   (generations/)   (registry.db)
```

### Two-Agent Pattern

AutoCoder uses a sophisticated two-phase approach:

1. **Initializer Agent (First Session)**
   - Reads application specification (XML format)
   - Creates feature test cases in SQLite database
   - Sets up project structure and git initialization
   - Generates initializer and coding prompts
   - Runs 10-20+ minutes (generating comprehensive test suite)

2. **Coding Agent (Subsequent Sessions)**
   - Picks up where previous session left off
   - Implements features one-by-one from the queue
   - Marks features as passing after successful implementation
   - Handles regression testing and dependency management
   - Each session typically 5-15 minutes per feature set

### Core Python Modules

**Agent Runtime:**
- `agent.py` - Agent session loop using Claude Agent SDK, handles rate limiting, error recovery, and session state management
- `autonomous_agent_demo.py` - Entry point supporting parallel, batch, and YOLO modes
- `client.py` - ClaudeSDKClient configuration with security hooks, MCP server registration, and alternative model support (Vertex AI, Ollama, GLM)

**Security & Validation:**
- `security.py` - Hierarchical bash command allowlist validation with org-level and project-level configuration
- Feature validation with circular dependency detection
- Filesystem sandboxing restricted to project directory
- Sensitive directory blocklist (SSH, AWS, GCP credentials)

**Data & State Management:**
- `api/database.py` - SQLAlchemy models for Feature tracking (priority, category, description, test steps, dependencies)
- `api/dependency_resolver.py` - Cycle detection (Kahn's algorithm + DFS), dependency validation, scheduling score computation
- `api/migration.py` - JSON to SQLite migration for backward compatibility

**Project Management:**
- `registry.py` - Cross-platform project registry using SQLite with POSIX path normalization
- `autocoder_paths.py` - Dual-path resolution supporting legacy root-level and new `.autocoder/` directory layouts
- `prompts.py` - Template loading with project-specific fallback support

**Process & Infrastructure:**
- `progress.py` - Progress tracking, database queries, webhook notifications (N8N integration)
- `parallel_orchestrator.py` - Concurrent agent execution with dependency-aware scheduling
- `rate_limit_utils.py` - Rate limit detection, retry parsing, exponential backoff with jitter
- `auth.py` - Claude CLI authentication error detection

### Backend Server Stack

**Framework & API:**
- **FastAPI 0.115.0+** - Async REST API with OpenAPI documentation
- **Uvicorn** - ASGI server with standard extras
- **WebSockets 13.0+** - Real-time bidirectional communication

**Database & ORM:**
- **SQLAlchemy 2.0+** - ORM for features, projects, schedules, settings, chat history
- **SQLite** - Persistent storage for projects and application state

**Process Management:**
- **APScheduler 3.10** - Time-based agent scheduling
- **psutil 6.0** - Process monitoring and lifecycle management
- **pywinpty 2.0** (Windows only) - PTY support for terminal integration

**Core Routers:**
- `projects.py` - Project CRUD, registry integration
- `features.py` - Feature management and status tracking
- `agent.py` - Agent process control (start, stop, pause, resume)
- `filesystem.py` - Secure filesystem browser with path canonicalization
- `terminal.py` - Interactive terminal with bidirectional WebSocket I/O
- `devserver.py` - Dev server lifecycle management
- `schedules.py` - Time-based agent scheduling CRUD
- `spec_creation.py` - Interactive spec creation chat (WebSocket)
- `expand_project.py` - Natural language project expansion (WebSocket)
- `assistant_chat.py` - Project-specific Q&A assistant (WebSocket + REST)

**Security Middleware:**
- Localhost-only access by default (disabled with `AUTOCODER_ALLOW_REMOTE=1`)
- CORS configuration with strict origin allowlisting
- Request validation and error handling

### Feature Management System

**Database Schema:**
```
Feature:
  - id: Integer (PK)
  - priority: Integer (scheduling order)
  - category: String (feature classification)
  - name: String (feature name)
  - description: String (detailed specification)
  - steps: JSON array (test/implementation steps)
  - passes: Boolean (completion status)
  - in_progress: Boolean (current agent work status)
  - dependencies: JSON array (feature ID dependencies)
  - created_at: DateTime
  - updated_at: DateTime
```

**MCP Server Tools:**
- `feature_get_stats()` - Progress statistics (passing, in_progress, total, percentage)
- `feature_get_by_id(id)` - Full feature details
- `feature_get_summary(id)` - Lightweight status info
- `feature_mark_passing(id)` - Mark feature complete
- `feature_mark_failing(id)` - Regression detection
- `feature_skip(id)` - Move to end of queue
- `feature_claim_and_get()` - Atomic claim for parallel mode
- `feature_get_ready()` - Features ready to implement
- `feature_get_blocked()` - Blocked features with reasons
- `feature_get_graph()` - Complete dependency graph
- `feature_create_bulk(features)` - Batch feature initialization
- Dependency management tools with cycle detection

**Atomic Operations:**
- Uses SQL-level transactions for cross-process safety
- Prevents double-passing in parallel mode
- Lock-free design for concurrent agent execution

### Frontend Architecture

**Framework Stack:**
- **React 19.0** - Component-based UI
- **TypeScript** - Static type checking
- **Vite 7.3** - Modern build tooling with hot reload
- **TanStack Query 5.72** - Data fetching and caching
- **Tailwind CSS 4.1** - Utility-first styling with neobrutalism design

**Component Hierarchy:**

```
App.tsx
├── ProjectSelection
│   └── FolderBrowser
├── MainDashboard
│   ├── AgentMissionControl
│   │   ├── Agent mascots (Spark, Fizz, Octo, Hoot, Buzz)
│   │   ├── Real-time status indicators
│   │   └── Agent controls (start, pause, stop)
│   ├── KanbanBoard (Feature status view)
│   │   ├── To Do
│   │   ├── In Progress
│   │   └── Done
│   └── DependencyGraph
│       ├── Node layout (dagre algorithm)
│       ├── Edge rendering
│       └── Interactive exploration
├── TerminalTabs (xterm.js)
│   ├── Multi-tab support
│   ├── Bidirectional WebSocket I/O
│   └── Copy/paste functionality
├── AssistantPanel
│   ├── Project-specific Q&A
│   ├── Chat history persistence
│   └── Real-time response streaming
├── ExpandProjectModal
│   ├── Natural language feature addition
│   └── Interactive chat interface
├── DevServerControl
│   ├── Start/stop dev servers
│   └── Auto-detection of dev commands
├── ScheduleModal
│   ├── Time-based agent triggers
│   ├── Recurring schedules
│   └── Manual overrides
└── SettingsModal
    ├── Model selection
    ├── YOLO/Batch mode toggles
    ├── Headless browser configuration
    └── Agent concurrency limits
```

**Real-Time Updates via WebSocket:**
- Message types: `progress`, `agent_status`, `log`, `feature_update`
- Per-project channels: `/ws/projects/{project_name}`
- Subscribe/unsubscribe on project selection
- Automatic reconnection with exponential backoff

**Key UI Features:**
- **Kanban Board** - Visual feature status management (drag-and-drop, status filtering)
- **Dependency Graph** - Interactive DAG visualization with dagre layout algorithm
- **Terminal Integration** - Full xterm.js terminal with multi-tab support
- **Celebration Overlay** - Confetti animation on feature completion
- **Keyboard Shortcuts** - Quick access to views (D=debug, G=graph, N=new, A=assistant, ,=settings)

### Dependency Management System

**Architecture:**
- Acyclic dependency graph (enforced via cycle detection)
- Topological sorting for scheduling
- Scheduling score computation

**Algorithms:**
- **Cycle Detection**: Kahn's algorithm + DFS for robust circular dependency prevention
- **Topological Sorting**: Scheduling-aware ordering
- **Feature Readiness**: Dependency satisfaction checking before implementation

**Configuration:**
- Maximum 20 dependencies per feature
- Automatic reordering based on dependency graph
- Regression testing of previously passing features

---

## Functional Aspects

### Primary Use Cases

1. **Rapid Application Prototyping**
   - Build MVPs and proof-of-concepts over multiple sessions
   - Automatic code generation from specifications
   - Real-time progress monitoring

2. **Feature Implementation & Iteration**
   - Break down applications into manageable features
   - Implement features with automated testing
   - Track progress across extended development timelines

3. **Multi-Session Development**
   - Resume work automatically between sessions
   - Persistent state via SQLite database
   - Full git history of all changes

4. **Interactive Development**
   - Natural language project expansion
   - AI-powered project Q&A assistant
   - Real-time terminal access

5. **CI/CD Integration**
   - Scheduled agent execution (via APScheduler)
   - N8N webhook notifications
   - Performance tracking and metrics

### Key Features

#### 1. Web UI Dashboard
- **Project Management**: Create, select, browse projects via folder picker
- **Real-Time Monitoring**: Live agent status, progress bars, feature updates
- **Kanban Board**: Visual feature lifecycle (To Do → In Progress → Done)
- **Dependency Graph**: Interactive DAG visualization for feature relationships
- **Terminal Integration**: Full PTY-backed terminal with multiple tabs
- **AI Assistant**: Project-specific Q&A (read-only queries)
- **Dev Server Control**: Start/stop local dev servers with auto-detection
- **Scheduling**: Time-based agent triggers with cron-like scheduling
- **Settings Panel**: Model selection, YOLO mode, browser configuration

#### 2. Multi-Mode Execution
- **Standard Mode**: Full feature implementation with testing
- **YOLO Mode**: Rapid prototyping without browser testing (skip Playwright)
- **Parallel Mode**: 1-5 concurrent agents with dependency-aware scheduling
- **Batch Mode**: Multiple features per agent session (1-3 features)
- **Targeted Batching**: Implement specific feature sets by ID

#### 3. Security & Sandboxing
- **Hierarchical Command Allowlist**:
  - Hardcoded blocklist (sudo, shutdown, dd, etc.)
  - Organization-level blocking (cannot be overridden)
  - Organization-level allowlist (available to all projects)
  - Global allowlist (default permitted commands)
  - Project-level allowlist (project-specific extensions)
- **Pattern Matching**: Exact names, prefix wildcards, script paths
- **Sensitive Directory Blocking**: SSH, AWS, GCP, Docker credentials
- **Filesystem Sandboxing**: Restricted to project directory + optional read-only external paths
- **Extra Read Paths**: Cross-project file access via canonicalized path resolution

#### 4. Feature Management
- **Database Persistence**: SQLite with SQLAlchemy ORM
- **Dependency Tracking**: Feature interdependencies with cycle detection
- **Status Tracking**: Pending, in-progress, passing, failing states
- **Regression Testing**: Automatic re-verification of passing features
- **Priority Scheduling**: Topological sorting with scheduling scores
- **Batch Operations**: Bulk feature creation and bulk status updates

#### 5. Integration Capabilities

**Alternative AI Models:**
- Claude API (default)
- Google Cloud Vertex AI
- Ollama (local models)
- Zhipu AI GLM models

**External Integrations:**
- **N8N Webhooks**: Progress notifications with test pass counts
- **GitHub Integration**: Full git version control
- **Dev Server Management**: Auto-detection and control of Node.js, Next.js, Vite servers

#### 6. Project Registry
- **Cross-Platform Support**: SQLite registry at `~/.autocoder/registry.db`
- **Path Normalization**: POSIX paths for Windows compatibility
- **Dual-Layout Support**: Legacy root-level and new `.autocoder/` directory structures
- **Auto-Migration**: Automatic layout migration on first agent run
- **Named Projects**: Map project names to full paths for easier reference

### Configuration Options

**Environment Variables (.env):**

```bash
# Progress Notification
PROGRESS_N8N_WEBHOOK_URL=https://your-n8n-instance.com/webhook/...

# Browser Configuration (Playwright)
PLAYWRIGHT_BROWSER=firefox|chrome|webkit|msedge  # Default: firefox
PLAYWRIGHT_HEADLESS=true|false                    # Default: true

# External Path Access
EXTRA_READ_PATHS=/path/to/docs,/path/to/libs     # Comma-separated

# Google Cloud Vertex AI (Alternative to Claude)
CLAUDE_CODE_USE_VERTEX=1
CLOUD_ML_REGION=us-east5
ANTHROPIC_VERTEX_PROJECT_ID=your-project-id
ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-5@20251101

# Zhipu AI GLM Models
ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
ANTHROPIC_AUTH_TOKEN=your-zhipu-api-key
ANTHROPIC_DEFAULT_OPUS_MODEL=glm-4.7

# Ollama Local Models
ANTHROPIC_BASE_URL=http://localhost:11434
ANTHROPIC_AUTH_TOKEN=ollama
ANTHROPIC_DEFAULT_OPUS_MODEL=qwen3-coder
```

**Project Configuration (.autocoder/allowed_commands.yaml):**
```yaml
version: 1
commands:
  - name: swift
    description: Swift compiler
  - name: swift*
    description: All Swift development tools
  - name: ./scripts/build.sh
    description: Project build script
pkill_processes:
  - custom-process
```

**Organization Configuration (~/.autocoder/config.yaml):**
```yaml
version: 1
allowed_commands:
  - name: jq
    description: JSON processor
blocked_commands:
  - aws
  - kubectl
pkill_processes:
  - allowed-process
```

### Target Audience

1. **Developers & Teams**
   - Building full-stack applications with AI assistance
   - Prototyping new features rapidly
   - Extending existing projects with new functionality

2. **Development Managers**
   - Monitoring ongoing development progress
   - Scheduling automated coding sessions
   - Integrating with CI/CD pipelines

3. **AI/ML Researchers**
   - Experimenting with autonomous coding capabilities
   - Evaluating agent performance and efficiency
   - Extending with custom MCP servers

4. **DevOps & Infrastructure Teams**
   - Deploying AutoCoder in organizational contexts
   - Setting up org-wide security policies
   - Integrating with existing tools (N8N, cloud platforms)

### Application Requirements

**System Requirements:**
- Python 3.11+
- Node.js 20+ (for UI development)
- Claude Code CLI (required for agent execution)
- 4GB+ RAM recommended
- 2GB+ disk space per project

**Runtime Dependencies:**
- Claude Pro/Max subscription OR Anthropic API key
- Internet connection for Claude API
- Modern browser (Chrome, Firefox, Safari, Edge)
- Git (for version control)

**Optional:**
- Docker (for PostgreSQL dev databases)
- Playwright (for browser automation testing)
- N8N instance (for webhooks)

### Workflow & Performance

**Feature Implementation Timeline:**
- **First Session (Initialization)**: 10-20+ minutes
  - Spec processing
  - Feature test case generation
  - Project structure setup
- **Subsequent Sessions**: 5-15 minutes each
  - Feature implementation
  - Automated testing
  - Regression verification
- **Total Project Time**: Hours to days depending on complexity
  - Scope: 20-50 features for quick demos
  - Scope: 100+ features for comprehensive applications

**Performance Optimizations:**
- Parallel mode: 1-5 concurrent agents (reduces total time by up to 5x)
- Batch mode: 1-3 features per session (amortizes setup overhead)
- YOLO mode: Skip testing for 30-50% faster iteration
- Query optimization: Aggregate statistics via single SQL query

---

## Design Patterns & Architecture Decisions

### 1. Two-Agent Pattern
**Why:** Separates concerns of spec interpretation (initializer) from code implementation (coder). Allows session-specific optimization.

### 2. MCP Server Integration
**Why:** Provides clean abstraction for feature management tools. Enables atomic operations across process boundaries.

### 3. Hierarchical Security Model
**Why:** Balances flexibility (project-level customization) with safety (org-level blocking). Defense-in-depth approach.

### 4. SQLite Persistence
**Why:** Single-file, serverless database. Supports atomic transactions. Cross-platform with POSIX path normalization.

### 5. Dependency Graph with Cycle Detection
**Why:** Prevents deadlocks in feature scheduling. Enables parallel execution with safety guarantees.

### 6. Lock-Free Concurrency
**Why:** Uses SQL-level transactions instead of OS locks. Supports multi-process parallel agents on same project.

### 7. Dual-Path File Layout
**Why:** Maintains backward compatibility with legacy projects while supporting new organized structure.

### 8. Real-Time WebSocket Architecture
**Why:** Enables instant progress visibility. Low latency for distributed teams. Better UX than polling.

---

## Technology Stack Summary

### Backend
| Component | Technology | Version |
|-----------|-----------|---------|
| Runtime | Python | 3.11+ |
| Agent SDK | Claude Agent SDK | 0.1.0+ |
| Web Framework | FastAPI | 0.115+ |
| Database | SQLAlchemy + SQLite | 2.0+ |
| Real-Time | WebSockets | 13.0+ |
| Process Mgmt | APScheduler | 3.10+ |
| Terminal PTY | pywinpty | 2.0+ (Windows) |

### Frontend
| Component | Technology | Version |
|-----------|-----------|---------|
| Framework | React | 19.0 |
| Language | TypeScript | 5.7.3 |
| Build Tool | Vite | 7.3 |
| Styling | Tailwind CSS | 4.1 |
| Data Fetching | TanStack Query | 5.72 |
| UI Components | Radix UI | Latest |
| Terminal | xterm.js | 6.0 |
| Graph Layout | dagre | 0.8.5 |

### DevOps & CI/CD
| Component | Technology |
|-----------|-----------|
| Version Control | Git |
| CI/CD | GitHub Actions |
| Container Support | Docker (optional) |
| Code Quality | ruff, mypy, eslint |
| Testing | pytest, playwright |

---

## Development & Community

**Recent Activity:**
- Created: December 30, 2025
- Last Push: February 1, 2026
- Active development with 1,290 stars and 315 forks

**Community Metrics:**
- 58 open issues
- 315 forks (active usage)
- Strong engagement for early-stage project

**Documentation:**
- Comprehensive README with video tutorial (YouTube)
- CLAUDE.md for AI-assisted development
- Inline code documentation
- Configuration examples for security policies

**Testing Infrastructure:**
- Python: ruff (lint), mypy (type check), pytest, security tests
- React: ESLint, TypeScript build, Playwright E2E tests
- CI/CD: GitHub Actions on push/PR to master

---

## Notable Innovations

1. **Autonomous Multi-Session Development**: First-of-its-kind autonomous coding agent that spans multiple sessions with persistent state

2. **Visual Dependency Graph**: Interactive DAG visualization enabling intuitive understanding of feature relationships

3. **Hierarchical Security Model**: Sophisticated allowlist system balancing flexibility and safety for organizational deployments

4. **Lock-Free Parallel Agents**: SQL-transaction-based concurrency enabling true parallel execution on shared projects

5. **MCP Server Integration**: Clean abstraction for tool management enabling extensibility

6. **Cross-Platform Path Normalization**: SQLite registry with POSIX paths supporting Windows deployments

7. **Dual-Layout File Organization**: Backward-compatible migration from root-level to `.autocoder/` directory structure

---

## Conclusion

AutoCoder represents a mature, production-ready autonomous coding agent system. Its comprehensive architecture spans multiple layers (agent, server, UI) with sophisticated features for security, concurrency, persistence, and user experience. The project demonstrates advanced engineering practices including atomic operations, hierarchical configuration systems, and real-time communication patterns. It serves as both a practical tool for AI-assisted development and a reference implementation for autonomous agent systems.

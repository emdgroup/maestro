# Automaker: AI-Powered Development Studio

## Overview
Automaker is an autonomous development platform that transforms software creation by enabling developers to orchestrate AI agents rather than manually coding. Users describe features on a Kanban board and watch AI agents automatically implement them using the Claude Agent SDK.

## Core Purpose
"Stop typing code. Start directing AI agents." The platform represents agentic coding—where developers become architects directing autonomous AI rather than manual implementers, potentially accelerating development cycles significantly.

## Key Features

**Workflow Management:**
- Kanban-style boards organizing features through backlog, in-progress, approval-pending, and verified stages
- Automatic AI agent assignment when features move to "In Progress"
- Real-time streaming of agent work with visible tool usage and progress updates
- Ability to send follow-up instructions to running agents mid-execution

**Technical Isolation & Safety:**
- Git worktree isolation ensures each feature executes independently without affecting the main branch
- Safe experimentation through containerized agent environments
- Plan approval workflows before implementation execution

**Multi-Agent Capabilities:**
- Powered by the Claude Agent SDK for autonomous agent operations
- Agents can read files, write code, execute commands, run tests, and make git commits
- Task-based execution with complex multi-step problem solving

## Technology Stack

**Frontend:** React, Vite, Electron (desktop), TypeScript

**Backend:** Express.js, Node.js 22+

**Testing:** Playwright (E2E), Vitest (unit tests)

**Infrastructure:** Docker support with multi-architecture builds, monorepo structure

**Authentication:** Claude Code CLI integration, GitHub CLI support for git operations

## Architecture Highlights

The system uses a monorepo design containing UI applications, backend services, shared libraries, and developer tooling. Features operate in isolated git worktrees, creating safe sandboxes for autonomous agent work while maintaining main branch integrity.

## Getting Started

Prerequisites include Node.js 22+, npm, and authenticated Claude Code CLI. Users can launch via `npm run dev` with options for Electron desktop, web browser, or interactive launcher modes.

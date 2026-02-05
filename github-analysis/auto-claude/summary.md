# Auto-Claude: Autonomous Multi-Agent Coding Framework

## Repository Description

Auto-Claude is an autonomous multi-agent coding framework that enables developers to describe software goals and have AI agents handle planning, implementation, and validation automatically.

## Core Features

**Autonomous Task Execution**: Agents independently manage the complete development lifecycle from specification through quality assurance without constant human intervention.

**Parallel Processing**: The system supports simultaneous execution across up to 12 agent terminals, allowing multiple builds to progress concurrently.

**Isolated Development**: All modifications occur within git worktrees, preserving the main branch's integrity during experimental builds.

**Built-in Quality Assurance**: An integrated validation pipeline identifies and resolves issues before code review, reducing manual testing overhead.

**Intelligent Merge Operations**: The framework automatically resolves conflicts when reintegrating changes back to the primary branch.

**Cross-Platform Integration**: Supports GitHub, GitLab, and Linear, enabling seamless workflow synchronization across popular development tools.

## Technology Stack

- **Frontend**: TypeScript/Electron (57.7% of codebase)
- **Backend**: Python (40.8% of codebase)
- **Core Integration**: Claude AI via API integration
- **Version Control**: Git-based workflow with worktree isolation

## Architecture

```
apps/
├── backend/     # Python agents, task specs, QA pipeline
└── frontend/    # Electron desktop application
```

## Key Capabilities

- Interactive specification creation via CLI
- Headless operation for CI/CD integration
- Kanban-based task visualization
- AI-powered terminal environments
- Automated changelog generation
- Codebase analysis and ideation tools

## License & Access

AGPL-3.0 licensed open-source software with commercial licensing available. Requires Claude Pro/Max subscription and the Claude Code CLI (`npm install -g @anthropic-ai/claude-code`).

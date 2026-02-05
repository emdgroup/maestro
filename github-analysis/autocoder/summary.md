# AutoCoder Repository Summary

## Project Description

AutoCoder is a long-running autonomous coding agent built on the Claude Agent SDK that can construct complete applications across multiple sessions. It employs a two-agent architecture where an initializer sets up the project structure and features, while a coding agent incrementally implements functionality.

## Core Features

- **Multi-session Development**: Projects persist progress through SQLite databases and git commits, allowing work to resume across sessions
- **Web UI Dashboard**: React-based interface at `http://localhost:5173` displaying project status, feature Kanban boards, and real-time agent output
- **CLI Mode**: Command-line alternative for headless operation
- **Feature Management**: SQLAlchemy-backed feature tracking with MCP-exposed tools for progress monitoring
- **Real-time Streaming**: WebSocket integration delivers live agent output and status updates to the UI
- **Security Framework**: Allowlist-based command validation restricting bash execution to approved utilities

## Technology Stack

**Backend**: Python with FastAPI, SQLAlchemy ORM, Claude SDK integration

**Frontend**: React 18, TypeScript, TanStack Query, Tailwind CSS v4, Radix UI components

**Data Layer**: SQLite via SQLAlchemy for feature persistence

**Communication**: WebSocket for bidirectional real-time updates, REST API for project management

## Architecture

The system operates through:

1. **Initializer Phase**: Parses app specifications, generates feature test cases, and establishes project scaffolding
2. **Coding Phase**: Sequentially implements features, marking completed work in the database
3. **MCP Server**: Exposes feature management tools (stats retrieval, priority selection, status updates)
4. **Backend Server**: FastAPI application managing project state and WebSocket connections
5. **Frontend UI**: Vite-powered React application consuming the REST API and streaming WebSocket events

## Key Capabilities

- Specification-driven development with interactive `/create-spec` command
- Automatic context preservation between sessions via database and git history
- Progress visualization with real-time feature status updates
- N8N webhook integration for external progress notifications
- Alternative model support via Zhipu AI's Claude-compatible API endpoint
- Multi-platform startup scripts (Windows batch, macOS/Linux shell)

## Licensing

The project is licensed under GNU Affero General Public License v3.0, authored by Leon van Zyl.

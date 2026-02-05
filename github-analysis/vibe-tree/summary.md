# VibeTree Project Summary

## Repository Description
VibeTree is a cross-platform application enabling developers to work on multiple git worktrees simultaneously with AI assistance. The project facilitates parallel development workflows without requiring branch switching or context loss.

## Core Functionality
The application allows users to "work on features simultaneously without stashing or switching branches." Each worktree maintains independent terminal sessions with full state preservation, supporting Claude CLI integration for AI-assisted coding tasks.

## Technology Stack
- **Language**: TypeScript (92.9% of codebase)
- **Frontend**: HTML (3.8%), JavaScript (1.2%)
- **Architecture**: Monorepo structure using pnpm workspaces and Turbo for build orchestration
- **Desktop**: Electron-based application
- **Backend**: Node.js socket server
- **Deployment**: Docker containerization with nginx reverse proxy

## Key Features
- Multi-worktree project management with tabbed interface
- Persistent terminal sessions per worktree
- IDE integration (VS Code, Cursor)
- Cross-platform support: desktop, web, and mobile access
- Dark/light mode with automatic OS theme detection
- One-command Docker deployment for cloud environments

## Architecture Components
The project comprises three main services:
1. **Web App** (port 3000): Browser-based UI with Vite
2. **Socket Server** (random 3XXX port): WebSocket communication layer
3. **Desktop App**: Electron wrapper for native OS integration

## Deployment Options
- Development mode via pnpm scripts
- Desktop applications for macOS, Windows, and Linux
- Docker containerized deployment for AWS EC2, Digital Ocean, and similar platforms
- LAN/mobile access via WebSocket connections

## License
MIT License

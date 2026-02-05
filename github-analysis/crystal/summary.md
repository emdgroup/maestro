# Crystal - Multi-Session AI Code Assistant Manager

## Repository Description

Crystal is a desktop application that enables developers to run multiple AI coding sessions in parallel using isolated git worktrees, supporting both Claude Code and OpenAI's Codex.

## Core Functionality

**Main Purpose:**
"Crystal lets you use AI on isolated copies of your code so you can work on multiple tasks instead of waiting for your agents to finish."

**Workflow:**
1. Create sessions from prompts in isolated git worktrees
2. Iterate with AI assistants; each iteration generates a commit for version control
3. Review diff changes and make manual edits as needed
4. Squash commits with new messages and merge to main branch

## Key Features

- **Multi-session management**: Run multiple AI sessions simultaneously
- **Rich output**: Comprehensive agent feedback visualization
- **Integrated testing**: Configure and run test scripts within the application
- **Diff viewer**: Review all changes before merging
- **Git operations**: Rebase from main, squash commits, manage worktrees
- **Support for multiple AI providers**: Compatible with both Claude Code and Codex

## Technology Stack

The project uses:
- **TypeScript** (96.8% of codebase)
- **JavaScript** (1.6%)
- **CSS** (1.4%)
- **Electron** framework for desktop application
- **pnpm** as package manager
- **Playwright** for testing

## Architecture

- **Frontend**: React-based UI in the `frontend/` directory
- **Main process**: Electron main process in `main/` directory
- **Shared utilities**: Common code in `shared/` directory
- **Build system**: Custom build scripts and configurations

## Prerequisites & Installation

**Requirements:**
- Git installed
- Claude Code or Codex with valid credentials/API keys
- Git repository (Crystal initializes if needed)

**Installation options:**
- Pre-built macOS DMG from releases
- Homebrew: `brew install --cask stravu-crystal`
- Build from source (requires Xcode Command Line Tools or build-essential)

## License & Attribution

Licensed under MIT. Project created by Stravu, independent of Anthropic and OpenAI, with 18 contributors.

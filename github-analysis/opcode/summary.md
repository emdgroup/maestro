# opcode: Claude Code Desktop Manager

## Overview

**opcode** is a desktop application that enhances interaction with Claude Code through a visual interface. Built with Tauri 2, it serves as a "command center" bridging CLI tools and intuitive GUI workflows for AI-assisted development.

## Core Functionality

The application manages Claude Code sessions with several key capabilities:

- **Project & Session Management**: Visual browsing of projects in `~/.claude/projects/`, session history with metadata, and smart search functionality
- **CC Agents**: Create specialized AI agents with custom prompts, run background processes, and track execution history
- **Usage Analytics**: Monitor API costs, token consumption by model/project, visualize trends, and export data
- **MCP Server Management**: Centralized configuration of Model Context Protocol servers with connection testing and Claude Desktop import
- **Timeline & Checkpoints**: Create session versions, navigate branching timelines, restore to checkpoints, and view diffs
- **CLAUDE.md Management**: Built-in editor with live markdown preview and project-wide file discovery

## Technology Stack

The project combines:
- **Frontend**: React 18, TypeScript, Vite 6, Tailwind CSS v4, shadcn/ui
- **Backend**: Rust with Tauri 2 framework
- **Data**: SQLite via rusqlite
- **Package Manager**: Bun

## Security Approach

The application emphasizes privacy through process isolation for agents, granular permission controls per agent, local-only data storage, and no telemetry collection. Its open-source nature provides full code transparency.

## Development Status

The project is under active development with 20.3k GitHub stars and welcomes contributions across bug fixes, features, documentation, UI/UX, testing, and internationalization. It's licensed under AGPL-3.0.

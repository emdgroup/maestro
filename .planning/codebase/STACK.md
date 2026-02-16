# Technology Stack

**Analysis Date:** 2026-02-14

## Languages

**Primary:**
- TypeScript 5.9.3 - Frontend application logic and Tauri IPC type definitions
- Rust 2021 edition - Desktop application backend via Tauri 2

**Secondary:**
- JavaScript - Build scripts (Vite, bundle verification)

## Runtime

**Environment:**
- Tauri 2 - Secure, lightweight desktop application framework
- Node.js - Development environment and build tooling (lockfile: pnpm-lock.yaml v9.0)

**Package Manager:**
- pnpm - Fast, efficient monorepo package manager (pnpm-lock.yaml present)

## Frameworks

**Core Frontend:**
- React 19.2.4 - UI component framework
- Vite 7.3.1 - Build tool and dev server (port 5173, HMR on 5174)

**UI & Components:**
- shadcn/ui - Radix UI primitive component library (`src/components/ui/`)
- Radix UI 1.x - Unstyled, accessible component primitives
- Lucide React 0.563.0 - Icon library

**State Management:**
- Zustand 4.5.0 - Lightweight state management with Immer middleware
- Immer 10.0.0 - Immutable state updates in reducers

**Forms & Validation:**
- React Hook Form 7.50.0 - Performant, flexible form validation

**Styling:**
- Tailwind CSS 4.1.18 - Utility-first CSS framework with `@tailwindcss/vite` plugin
- CSS Modules - Component-scoped styling
- `tailwindcss-animate` 1.0.7 - Animation utilities

**Drag & Drop:**
- `@dnd-kit/core` 6.3.1 - Headless drag-and-drop library
- `@dnd-kit/sortable` 10.0.0 - Sortable preset for dnd-kit

**Terminal & Process Management:**
- xterm.js 5.3.0 - Web-based terminal emulator
- `@xterm/addon-attach` 0.10.0 - Terminal attachment plugin
- `@xterm/addon-fit` 0.11.0 - Terminal autofit plugin

**Notifications:**
- Sonner 1.5.0 - Toast notification library

**Testing:**
- Playwright 1.58.2 - E2E testing framework
- Chrome (Chromium) as target browser

## Key Dependencies

**Critical Infrastructure:**
- `@tauri-apps/api` 2.10.1 - Tauri frontend API for IPC communication
- `@tauri-apps/plugin-dialog` 2.6.0 - Native file/folder dialogs
- `@tauri-apps/plugin-opener` 2 - Open URLs and files with system defaults
- `@tauri-apps/plugin-shell` 2.3.5 - Shell command execution

**Utilities:**
- `clsx` 2.1.1 - Conditional class name builder
- `class-variance-authority` 0.7.1 - Type-safe component variant system
- `tailwind-merge` 3.4.0 - Intelligent Tailwind class merging
- `culori` 4.0.2 - Color manipulation and conversion library

**Backend (Rust):**
- `tauri` 2 - Desktop application runtime
- `rusqlite` 0.31 - SQLite database driver with bundled SQLite
- `serde` 1.0, `serde_json` 1.0 - Serialization/deserialization
- `ts-rs` 7.1 - Generate TypeScript types from Rust structs
- `chrono` 0.4 - Date/time handling (RFC3339 format)
- `reqwest` 0.11 - Async HTTP client for GitHub/Jira API calls
- `tokio` 1.0 (full features) - Async runtime
- `ssh2` 0.9 - SSH client protocol support
- `portable-pty` 0.8 - Cross-platform PTY (pseudo-terminal) support
- `keyring` 2.0 - System credential storage for SSH passwords
- `zeroize` 1.6 - Secure password memory clearing
- `base64` 0.22 - Base64 encoding for Basic Auth

**Platform-Specific (Windows):**
- `windows` 0.58 - Windows API bindings for UI/theme integration

## Configuration

**Environment:**
- `.env` files not committed (credentials stored in SQLite settings table via system keyring)
- Theme preference persisted in SQLite `settings` table
- SSH passwords stored securely using system `keyring` crate

**Build:**
- `vite.config.ts` - Vite configuration with React and Tailwind plugins
- `tsconfig.json` - TypeScript strict mode enabled, ES2020 target
- `components.json` - shadcn/ui configuration (Tailwind aliases, baseColor: neutral)
- `tauri.conf.json` - Tauri app configuration (window size, bundle settings, build commands)
- `playwright.config.ts` - E2E test configuration (baseURL: localhost:5173, reporter: html)
- `Cargo.toml` - Rust dependencies, ts-rs export directory (`../src/types`)

**Path Aliases:**
- `@` → `./src`
- `@/components` → `./src/components`
- `@/components/ui` → `./src/components/ui`
- `@/lib` → `./src/lib`
- `@/hooks` → `./src/hooks`

## Database

**SQLite 3:**
- Location (per platform):
  - Linux: `~/.local/share/gsd-demo/gsd-demo.db`
  - macOS: `~/Library/Application Support/gsd-demo/gsd-demo.db`
  - Windows: `%APPDATA%/gsd-demo/gsd-demo.db`
- Schema version 8 (auto-migrated on first run via `src-tauri/src/db/schema.rs`)
- Foreign key constraints enabled
- Tables: `projects`, `tasks`, `worktrees`, `execution_logs`, `settings`, `task_reviews`, `review_comments`, `known_hosts`, `ssh_connections`

## Platform Requirements

**Development:**
- Node.js with pnpm
- Rust toolchain (for backend development)
- Platform-native build tools (Xcode on macOS, Visual Studio on Windows, build-essential on Linux)
- System keyring/credential manager (for SSH password storage)

**Production Deployment:**
- Cross-platform desktop application via Tauri 2
- Targets: macOS (Intel + ARM), Windows (10+), Linux (GTK-based)
- Self-contained bundle with Rust backend and Vite-built React frontend
- Requires system keyring support for SSH credential management

**Development Server:**
- Vite dev server on localhost:5173
- HMR over WebSocket on localhost:5174 (for remote dev scenarios)
- Playwright runs against dev server for E2E tests

---

*Stack analysis: 2026-02-14*

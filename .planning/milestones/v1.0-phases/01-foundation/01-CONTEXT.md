# Phase 1: Foundation - Context

**Gathered:** 2026-02-04
**Status:** Ready for planning

<domain>
## Phase Boundary

Establish database persistence (SQLite), app shell (Tauri + React), and type definitions so all subsequent phases have a solid foundation. This includes schema for projects/tasks/worktrees/logs, IPC communication layer, and shared types across Rust/TypeScript.

</domain>

<decisions>
## Implementation Decisions

### Type System Architecture
- **Code generation:** Use ts-rs or similar to auto-generate TypeScript types from Rust structs (single source of truth in Rust)
- **Runtime validation:** Trust compile-time types from codegen — no runtime validation with Zod/similar
- **Type separation:** Separate API types from DB types (database models vs API responses have distinct types)
- **Enum handling:** TypeScript uses string literal union types (e.g., `'Pending' | 'Running'`), not TypeScript enums

### App Initialization Flow
- **First launch:** Direct to project picker (folder picker dialog immediately, no onboarding flow)
- **Missing project recovery:** Remember recent projects — show list of recent projects or pick new one
- **Default settings:** Minimal config file from start (editable config file with sensible defaults, not hardcoded)

### Claude's Discretion
- Project validation level (git repo check vs full validation)
- Database schema migration strategy
- IPC command structure and patterns
- Error handling across IPC boundary

</decisions>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches for Tauri + React + SQLite architecture.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 01-foundation*
*Context gathered: 2026-02-04*

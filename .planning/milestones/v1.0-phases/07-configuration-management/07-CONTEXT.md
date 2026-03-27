# Phase 7: Configuration Management - Context

**Gathered:** 2026-02-07
**Status:** Ready for planning

<domain>
## Phase Boundary

Enable users to control agent capabilities through task and project-level configuration. Users set project-wide defaults (Claude model, MCP server allowlist, Skills availability) and override those defaults per task for specific agent execution requirements. Configuration affects agent behavior but does not change task workflow or execution infrastructure.

</domain>

<decisions>
## Implementation Decisions

### Configuration UI Organization
- Project-level configuration lives in a **dedicated settings screen** (separate from project picker)
- Settings accessed via **gear icon in header** (standard pattern, always visible)
- Opens modal or slide-out panel for all project configuration
- Task-level overrides accessed via **context menu on task card** (right-click or three-dot menu → Edit Settings)
- Task settings open in a **separate settings modal** (not in task creation modal)
- Keeps task creation simple, allows post-creation configuration changes

### MCP Server Configuration
- Project-level: **Allowlist checkboxes** (opt-in model)
- List all available MCP servers, user checks which are enabled by default
- Simple on/off per server (no grouping or categories)
- Task-level: **Full override** model
- Task gets its own independent MCP allowlist that completely replaces project defaults
- No inheritance display — task settings stand alone

### Skills Configuration
- Project-level: **Checkboxes** (consistent with MCP pattern)
- List all available Skills, user checks which are available by default
- Task-level: **Full override** model (consistent with MCP)
- Task gets independent Skills list that replaces project defaults
- No additive or restrictive semantics — complete replacement

### Claude's Discretion
- Model selection UX (dropdown, presets, version picker)
- Settings modal layout and visual design
- Error messaging for invalid configurations
- Settings persistence timing (on change vs on save)
- Default project configuration values for new projects

</decisions>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches for settings UI and configuration management.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 07-configuration-management*
*Context gathered: 2026-02-07*

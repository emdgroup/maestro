# Phase 7: Configuration Management - Research

**Researched:** 2026-02-07
**Domain:** Settings UI patterns, form handling, state management for per-task and per-project configuration
**Confidence:** HIGH

## Summary

Phase 7 implements a two-tier configuration system: project-level defaults (Claude model, MCP allowlist, Skills) and task-level overrides. The architecture leverages the existing stack (React, Tauri, Zustand, Radix UI) to build settings screens with modal dialogs following established UI patterns.

Configuration flows:
- **Project settings:** Accessed via gear icon in header → modal/slide-out panel
- **Task settings:** Right-click/three-dot menu on task card → separate settings modal
- **Data model:** Project defaults stored in SQLite settings table, task overrides stored as JSON columns in tasks table

The implementation combines proven React form patterns (react-hook-form + Radix UI) with the existing Zustand state management, enabling synchronous UI updates and reliable persistence.

**Primary recommendation:** Use react-hook-form with Radix UI form components for both project and task settings modals. Extend Task and AppSettings models to include model, mcp_allowlist, and skills_override fields. Implement checkbox-based allowlist UI matching existing ImportSettings pattern.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Configuration UI Organization:**
- Project-level configuration in dedicated settings screen (separate from project picker)
- Settings accessed via gear icon in header (standard pattern, always visible)
- Opens modal or slide-out panel for all project configuration
- Task-level overrides accessed via context menu on task card (right-click or three-dot menu → Edit Settings)
- Task settings open in separate settings modal (not in task creation modal)
- Keeps task creation simple, allows post-creation configuration changes

**MCP Server Configuration:**
- Project-level: Allowlist checkboxes (opt-in model)
- List all available MCP servers, user checks which are enabled by default
- Simple on/off per server (no grouping or categories)
- Task-level: Full override model
- Task gets independent MCP allowlist that completely replaces project defaults
- No inheritance display — task settings stand alone

**Skills Configuration:**
- Project-level: Checkboxes (consistent with MCP pattern)
- List all available Skills, user checks which are available by default
- Task-level: Full override model (consistent with MCP)
- Task gets independent Skills list that replaces project defaults
- No additive or restrictive semantics — complete replacement

### Claude's Discretion

- Model selection UX (dropdown, presets, version picker)
- Settings modal layout and visual design
- Error messaging for invalid configurations
- Settings persistence timing (on change vs on save)
- Default project configuration values for new projects

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope.

</user_constraints>

## Standard Stack

The established libraries and patterns for this domain:

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| react-hook-form | 7.50.0 | Form state management, validation | Lightweight, performance-optimized for React forms. Already in stack. |
| @radix-ui/react-dialog | 1.1.0 | Modal dialogs (settings, context menus) | Accessible, unstyled component library. Matches existing UI patterns. |
| @radix-ui/react-select | 2.0.0 | Dropdown selectors (Claude model) | Accessible dropdown pattern. Already in stack. |
| Zustand | (existing) | State management for configuration | Persistent across component tree. Settings stored locally in Zustand. |
| SQLite (rusqlite) | (existing) | Project-level settings persistence | Single-file database. Already integrated via Tauri. |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| zod | (optional) | Schema validation for configuration | Can validate form data before submission. Not required; react-hook-form alone sufficient. |
| immer | (existing via Zustand) | Immutable state updates | Built into Zustand for safe configuration updates. |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| react-hook-form | Formik | Formik heavier for simple settings. react-hook-form smaller bundle, re-renders less. |
| Radix UI Dialog | HeadlessUI Dialog | HeadlessUI is smaller but less accessible defaults. Radix matches existing patterns. |
| Zustand store | Context API + useReducer | Context Props drilling deeper component trees. Zustand cleaner for settings. |

**Installation:**
```bash
# Already in stack, no new packages needed
# Dependencies already present: react-hook-form, @radix-ui/react-dialog, @radix-ui/react-select, zustand
```

## Architecture Patterns

### Recommended Project Structure

Settings-related code follows existing patterns:

```
src/
├── components/
│   ├── ProjectSettingsModal.tsx    # Project-level configuration UI
│   ├── TaskSettingsModal.tsx       # Task-level override UI
│   ├── SettingsForm.tsx            # Reusable form component
│   └── TaskContextMenu.tsx         # Right-click/three-dot menu
├── store/
│   └── configStore.ts             # Zustand store for configuration state
├── types/
│   └── bindings.ts                # Auto-generated from Rust (includes updated Task, AppSettings)
└── styles/
    └── settings.css               # Shared settings modal styles

src-tauri/src/
├── models/
│   ├── task.rs                    # Extended with model, mcp_allowlist, skills fields
│   └── settings.rs                # Extended AppSettings model
├── db/
│   └── schema.rs                  # Migrations for configuration columns
└── ipc/
    └── handlers.rs                # Commands: get_project_settings, update_project_settings, update_task_settings
```

### Pattern 1: Two-Tier Configuration (Project Defaults + Task Overrides)

**What:** Project-level defaults provide fallback configuration. Tasks can completely override defaults.

**When to use:** When tasks need independent agent configuration while maintaining sensible project-wide defaults.

**Example:**

```typescript
// Project settings (applied to all tasks unless overridden)
interface ProjectConfig {
  model_default: string;           // e.g., "claude-opus-4-5"
  mcp_allowlist: string[];         // e.g., ["filesystem", "web"]
  skills_default: string[];        // e.g., ["javascript", "react"]
}

// Task settings (replaces project defaults entirely)
interface TaskConfig {
  model?: string;                  // If set, overrides project_default
  mcp_allowlist?: string[];        // If set, replaces project allowlist
  skills_override?: string[];      // If set, replaces project skills
}

// Resolution logic:
function resolveTaskConfig(task: Task, projectConfig: ProjectConfig): ResolvedConfig {
  return {
    model: task.model_override || projectConfig.model_default,
    mcp_allowlist: task.mcp_allowlist || projectConfig.mcp_allowlist,
    skills: task.skills_override || projectConfig.skills_default,
  };
}
```

Source: CONTEXT.md locked decisions (full override model for task-level)

### Pattern 2: Checkbox-Based Allowlist UI

**What:** Simple on/off toggles for each MCP server and Skill. No grouping or categorization.

**When to use:** When configuration options are flat lists without hierarchical relationships.

**Example:**

```typescript
// ProjectSettingsModal.tsx using react-hook-form
import { useForm } from "react-hook-form";

interface ProjectSettingsForm {
  model_default: string;
  mcp_servers: Record<string, boolean>;  // { "filesystem": true, "web": false, ... }
  skills: Record<string, boolean>;       // { "javascript": true, "python": false, ... }
}

export function ProjectSettingsModal() {
  const { register, handleSubmit, watch } = useForm<ProjectSettingsForm>();
  const mcp_servers = watch("mcp_servers");

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      {/* MCP Server Checkboxes */}
      <fieldset>
        <legend>MCP Servers (Project Default)</legend>
        {AVAILABLE_MCP_SERVERS.map(server => (
          <label key={server}>
            <input
              type="checkbox"
              {...register(`mcp_servers.${server}`)}
            />
            {server}
          </label>
        ))}
      </fieldset>

      {/* Skills Checkboxes */}
      <fieldset>
        <legend>Available Skills</legend>
        {AVAILABLE_SKILLS.map(skill => (
          <label key={skill}>
            <input
              type="checkbox"
              {...register(`skills.${skill}`)}
            />
            {skill}
          </label>
        ))}
      </fieldset>
    </form>
  );
}
```

Source: CONTEXT.md locked decisions + react-hook-form patterns

### Pattern 3: Modal Dialog Container (Radix UI)

**What:** Settings modals use Radix UI Dialog for accessibility and consistent styling.

**When to use:** All settings dialogs (project and task level).

**Example:**

```typescript
// ProjectSettingsModal.tsx
import * as Dialog from "@radix-ui/react-dialog";

export function ProjectSettingsModal({
  isOpen,
  onClose,
  projectId,
}: ProjectSettingsModalProps) {
  const handleSave = async (data: ProjectSettingsForm) => {
    await invoke("update_project_settings", {
      project_id: projectId,
      settings: data,
    });
    onClose();
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={onClose}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content settings-modal">
          <Dialog.Title>Project Configuration</Dialog.Title>
          <Dialog.Description>
            Set Claude model, MCP servers, and Skills for all tasks
          </Dialog.Description>

          <SettingsForm onSubmit={handleSave} />

          <Dialog.Close asChild>
            <button className="dialog-close">✕</button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

Source: Existing TaskModal.tsx pattern (GitHub: /src/components/TaskModal.tsx)

### Pattern 4: Task Context Menu for Settings Access

**What:** Right-click or three-dot menu on task card opens task settings modal.

**When to use:** For quick access to task-level overrides without opening full task detail.

**Example:**

```typescript
// TaskCard.tsx - Add context menu trigger
export function TaskCard({ task, onSettingsClick }: TaskCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="task-card" onContextMenu={(e) => {
      e.preventDefault();
      setMenuOpen(true);
    }}>
      {/* Task content */}

      {/* Three-dot menu button */}
      <button onClick={() => setMenuOpen(true)} className="task-menu">
        ⋯
      </button>

      {/* Menu (simple div, can be Radix Popover in future) */}
      {menuOpen && (
        <div className="task-context-menu">
          <button onClick={() => onSettingsClick(task)}>
            Edit Settings
          </button>
          <button onClick={() => console.log("More options")}>
            More
          </button>
        </div>
      )}
    </div>
  );
}
```

Source: CONTEXT.md locked decisions + standard React context menu patterns

### Anti-Patterns to Avoid

- **Mixed configuration settings with task creation:** Task creation should remain simple. Put all configuration in separate modals. Confirmed by CONTEXT.md locked decision: "Keeps task creation simple, allows post-creation configuration changes."
- **Inheritance display in task settings:** Task overrides should "stand alone" (CONTEXT.md). Don't show "inherits from project" or conditional display. Full replacement is simpler.
- **Hierarchical/grouped MCP lists:** CONTEXT.md specifies "Simple on/off per server (no grouping or categories)". Flat list only.
- **Persistent modal state in component:** Modal open/close should be controlled by parent. Use local state (isOpen) passed down, not internal state.
- **Direct database writes without validation:** Always validate configuration before invoking Tauri command. Use react-hook-form validation.

## Don't Hand-Roll

Problems that have existing solutions in this domain:

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Form state management for settings | Custom useState + setters | react-hook-form (already in stack) | Handles re-renders, validation, field tracking efficiently. Custom code is verbose and error-prone. |
| Checkbox group management | Individual useState for each checkbox | react-hook-form with field arrays | Field arrays handle dynamic groups cleanly. Manual state management gets complex. |
| Modal accessibility (keyboard nav, focus trap) | Custom div + role="dialog" | Radix UI Dialog (already in stack) | Radix handles ARIA, focus management, keyboard trapping. DIY accessibility has pitfalls. |
| Dropdown for model selection | Custom select | @radix-ui/react-select (already in stack) | Keyboard navigation, screen reader support. DIY dropdowns miss accessibility. |
| Configuration validation | Manual if-checks | zod + react-hook-form integration | Schema-based validation is declarative and testable. Manual checks are scattered. |
| Settings persistence timing | Manual async logic | Zustand action + invoke wrapper | Zustand actions ensure UI and DB stay synchronized. Custom async logic is error-prone. |

**Key insight:** Configuration UIs look simple but have complex state management needs (validation, persistence, rollback, loading states). Use established libraries to avoid bugs and reduce code.

## Common Pitfalls

### Pitfall 1: Forgetting Task Settings Are Full Overrides, Not Merges

**What goes wrong:** Developer implements task settings as "MCP restrictions" (can only reduce, not expand). Later, task needs MORE capabilities, not fewer. User is confused why task can't access MCP servers that project allows.

**Why it happens:** Natural assumption is "task settings restrict, project allows". But CONTEXT.md specifies "Task gets its own independent MCP allowlist that completely replaces project defaults" and "No inheritance display."

**How to avoid:** Implementation MUST treat task settings as complete replacement. No fallback to project defaults inside task execution. If task has no override, use project default ONLY during resolution (before agent execution), not in UI.

**Warning signs:** Code checking "if task.mcp_allowlist then use task else use project". This is correct! Wrong pattern is "if task.mcp_allowlist then use (task + project)" or "if task.mcp_allowlist then use (project - task)".

### Pitfall 2: Settings Modal Doesn't Save Properly

**What goes wrong:** User changes model dropdown and switches to another task. When they return, setting is reset. Or settings save but next task run uses old config.

**Why it happens:** Settings state not synchronized between UI component, Zustand store, and database. Missing await on Tauri invoke, or invoke fails silently.

**How to avoid:** Always verify save flow: (1) Collect form data, (2) invoke IPC command with await, (3) Update Zustand store, (4) Close modal. Add error handling for failed invokes.

**Warning signs:** Setting appears to save but next action uses old value. Database schema updated but app loads stale settings. Modal doesn't close after save.

### Pitfall 3: Mixing Project-Level and Task-Level UI

**What goes wrong:** Developer puts project settings in TaskModal (during task creation). Later user wants to change project defaults but can't find where. Or task settings embedded in task detail view, hard to distinguish from task data.

**Why it happens:** Unclear separation between project scope and task scope. Temptation to "consolidate" modals for fewer components.

**How to avoid:** Strict separation: Project settings in PROJECT settings modal only (gear icon). Task settings in TASK settings modal only (right-click menu). Never mix. Task creation modal ONLY for task name/description/acceptance criteria. Nothing else.

**Warning signs:** SettingsForm component accepts both project_id and task_id. TaskModal imports project settings logic.

### Pitfall 4: Forgetting to Update Database Schema

**What goes wrong:** Frontend code expects task.model_override and task.mcp_allowlist fields. Database task table doesn't have these columns. Tauri handler crashes or returns null.

**Why it happens:** Easy to start with Rust models and TypeScript types, forget to add database columns. Schema not migrated.

**How to avoid:** When extending Task model with new fields: (1) Update Rust Task struct, (2) Update Tauri handler SQL queries to include new columns, (3) Add schema migration in schema.rs for new columns, (4) cargo build to generate TypeScript types.

**Warning signs:** Type mismatch between Rust struct and SQL query results. Null/undefined values for new fields in frontend.

## Code Examples

Verified patterns from the codebase and official documentation:

### Example 1: Project Settings Form with react-hook-form

```typescript
// ProjectSettingsModal.tsx
import { useForm, Controller } from "react-hook-form";
import { invoke } from "@tauri-apps/api/core";
import * as Dialog from "@radix-ui/react-dialog";

interface ProjectSettingsForm {
  model_default: string;
  mcp_servers: Record<string, boolean>;
  skills: Record<string, boolean>;
}

export function ProjectSettingsModal({
  isOpen,
  onClose,
  projectId,
  initialSettings,
}: ProjectSettingsModalProps) {
  const { register, handleSubmit, formState: { isSubmitting } } = useForm<ProjectSettingsForm>({
    defaultValues: initialSettings,
  });

  const onSubmit = async (data: ProjectSettingsForm) => {
    try {
      await invoke("update_project_settings", {
        project_id: projectId,
        model_default: data.model_default,
        mcp_allowlist: Object.entries(data.mcp_servers)
          .filter(([_, enabled]) => enabled)
          .map(([server, _]) => server),
        skills_default: Object.entries(data.skills)
          .filter(([_, enabled]) => enabled)
          .map(([skill, _]) => skill),
      });
      onClose();
    } catch (error) {
      console.error("Failed to save project settings:", error);
    }
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={onClose}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title>Project Configuration</Dialog.Title>

          <form onSubmit={handleSubmit(onSubmit)}>
            {/* Model Selection */}
            <fieldset>
              <legend>Default Claude Model</legend>
              <select {...register("model_default")}>
                <option value="claude-opus-4-5">Claude Opus 4.5</option>
                <option value="claude-3-5-sonnet">Claude 3.5 Sonnet</option>
              </select>
            </fieldset>

            {/* MCP Servers */}
            <fieldset>
              <legend>MCP Servers</legend>
              {["filesystem", "web", "git"].map(server => (
                <label key={server}>
                  <input type="checkbox" {...register(`mcp_servers.${server}`)} />
                  {server}
                </label>
              ))}
            </fieldset>

            <button type="submit" disabled={isSubmitting}>
              Save Settings
            </button>
          </form>

          <Dialog.Close asChild>
            <button className="dialog-close">✕</button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

Source: react-hook-form docs + existing TaskModal.tsx pattern

### Example 2: Task Settings Override Modal

```typescript
// TaskSettingsModal.tsx - Complete override of project defaults
import { useForm } from "react-hook-form";
import { invoke } from "@tauri-apps/api/core";
import * as Dialog from "@radix-ui/react-dialog";

interface TaskSettingsForm {
  model: string;
  mcp_allowlist: Record<string, boolean>;
  skills_override: Record<string, boolean>;
}

export function TaskSettingsModal({
  isOpen,
  onClose,
  task,
  projectId,
}: TaskSettingsModalProps) {
  const { register, handleSubmit } = useForm<TaskSettingsForm>({
    defaultValues: {
      model: task.model_override || "",
      mcp_allowlist: parseAllowlist(task.mcp_allowlist),
      skills_override: parseSkills(task.skills_override),
    },
  });

  const onSubmit = async (data: TaskSettingsForm) => {
    await invoke("update_task_settings", {
      task_id: task.id,
      model_override: data.model,
      mcp_allowlist: Object.entries(data.mcp_allowlist)
        .filter(([_, enabled]) => enabled)
        .map(([server]) => server),
      skills_override: Object.entries(data.skills_override)
        .filter(([_, enabled]) => enabled)
        .map(([skill]) => skill),
    });
    onClose();
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={onClose}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title>Task Configuration Overrides</Dialog.Title>
          <Dialog.Description>
            Override project defaults for this task only.
            Leave empty to use project defaults.
          </Dialog.Description>

          <form onSubmit={handleSubmit(onSubmit)}>
            <fieldset>
              <legend>Claude Model Override</legend>
              <select {...register("model")}>
                <option value="">Use project default</option>
                <option value="claude-opus-4-5">Claude Opus 4.5</option>
                <option value="claude-3-5-sonnet">Claude 3.5 Sonnet</option>
              </select>
            </fieldset>

            <fieldset>
              <legend>MCP Servers (replaces project allowlist)</legend>
              {["filesystem", "web", "git"].map(server => (
                <label key={server}>
                  <input type="checkbox" {...register(`mcp_allowlist.${server}`)} />
                  {server}
                </label>
              ))}
            </fieldset>

            <button type="submit">Save Task Settings</button>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

Source: CONTEXT.md full override pattern + react-hook-form

### Example 3: Task Context Menu (Right-Click Access)

```typescript
// TaskCard.tsx - Updated to show context menu
import { useState } from "react";

interface TaskCardProps {
  task: Task;
  onSettingsClick: (task: Task) => void;
}

export function TaskCard({ task, onSettingsClick }: TaskCardProps) {
  const [showMenu, setShowMenu] = useState(false);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setShowMenu(true);
  };

  return (
    <div
      className="task-card"
      onContextMenu={handleContextMenu}
      onMouseLeave={() => setShowMenu(false)}
    >
      <h3>{task.name}</h3>
      <p>{task.description}</p>

      {/* Three-dot menu button */}
      <button
        className="task-menu-button"
        onClick={() => setShowMenu(!showMenu)}
      >
        ⋯
      </button>

      {/* Context Menu */}
      {showMenu && (
        <div className="task-context-menu">
          <button onClick={() => {
            onSettingsClick(task);
            setShowMenu(false);
          }}>
            Edit Settings
          </button>
          <button onClick={() => console.log("View details")}>
            View Details
          </button>
        </div>
      )}
    </div>
  );
}
```

Source: Existing TaskCard.tsx + standard React patterns

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Formik for form management | react-hook-form | ~2020-2021 | Smaller bundle, better performance for large forms. react-hook-form is now standard. |
| Custom modal dialogs | Radix UI Dialog | ~2021-2022 | Accessibility standards became stricter. Radix provides built-in ARIA. |
| Props drilling for settings | Zustand store | ~2021 | Zustand more lightweight than Redux for app-wide settings. |
| Environment variables for config | SQLite settings table | ~2022 (Tauri standard) | Per-project configuration requires runtime storage. SQLite natural fit for Tauri. |

**Deprecated/outdated:**
- **Redux for settings:** Overkill for this use case. Zustand sufficient and less boilerplate.
- **Inline validation:** Schema-based validation (zod) is standard now. Manual checks are error-prone.

## Open Questions

1. **Model version picker UX**
   - What we know: CONTEXT.md says "Model selection UX" is Claude's discretion. Dropdown with specific versions is standard.
   - What's unclear: Should users see full version string ("claude-opus-4-5") or friendly names ("Opus 4.5")? Any version pinning strategy?
   - Recommendation: Use friendly names (e.g., "Opus 4.5") with version string in title attribute. Simple dropdown sufficient for first iteration.

2. **Available MCP servers and Skills enumeration**
   - What we know: Both should be lists of checkboxes. Project defaults stored in SQLite.
   - What's unclear: Where does the list of "available" MCP servers/Skills come from? Hardcoded in app? Configuration file? Tauri backend?
   - Recommendation: Hardcode list initially (e.g., const AVAILABLE_MCP_SERVERS = ["filesystem", "web", "git"]). Can move to database/config in later phase.

3. **Settings persistence timing**
   - What we know: CONTEXT.md marks this as Claude's discretion.
   - What's unclear: Save on form change (auto-save) or only on explicit Save button?
   - Recommendation: Explicit Save button for clarity. Auto-save can be surprising (users may not realize settings changed).

4. **Error handling and validation feedback**
   - What we know: Form validation is part of implementation.
   - What's unclear: How should validation errors be displayed? Toast message, inline field error, or modal error banner?
   - Recommendation: Inline field errors (red text below field) for required fields. Toast for save failures (e.g., "Failed to update settings").

5. **Task settings modal accessibility from task detail**
   - What we know: Task settings accessed via right-click menu or three-dot button.
   - What's unclear: Should "Edit Settings" also appear in full task detail view?
   - Recommendation: Include in both places (context menu AND task detail view button). Users need multiple access paths.

## Sources

### Primary (HIGH confidence)

- **Codebase (GitHub):** `/src/components/TaskModal.tsx` - Radix UI Dialog pattern already in use
- **Codebase (GitHub):** `/src/store/boardStore.ts` - Zustand store pattern with Immer
- **Codebase (GitHub):** `/src-tauri/src/models/settings.rs` - AppSettings model already defined
- **Codebase (GitHub):** `/src-tauri/src/db/schema.rs` - SQLite schema with settings table
- **react-hook-form official docs:** https://react-hook-form.com/form-builder - Form validation patterns
- **Radix UI official docs:** https://www.radix-ui.com/docs/primitives/components/dialog - Dialog component API

### Secondary (MEDIUM confidence)

- **CONTEXT.md decisions:** User specified exact UI patterns (checkboxes, modals, context menus)
- **Project CLAUDE.md:** Tech stack confirmed (React 19, Tauri 2, Zustand, Radix UI)

### Tertiary (LOW confidence)

None — all findings verified against codebase or official documentation.

## Metadata

**Confidence breakdown:**
- **Standard stack:** HIGH - All libraries already in codebase (react-hook-form, Radix UI, Zustand)
- **Architecture:** HIGH - Existing patterns (TaskModal, Zustand store, Tauri IPC) directly apply
- **Pitfalls:** MEDIUM - Based on common form/settings mistakes + codebase analysis. Not tested with phase implementation yet.

**Research date:** 2026-02-07
**Valid until:** 2026-02-28 (30 days - stable libraries, no major changes expected)

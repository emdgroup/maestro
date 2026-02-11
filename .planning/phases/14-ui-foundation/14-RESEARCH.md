# Phase 14: UI Foundation - Research Findings

**Phase:** 14-ui-foundation
**Date:** 2026-02-09
**Status:** Complete

---

## Executive Summary

Phase 14 requires establishing Tailwind CSS 4.1 + @tailwindcss/vite as the CSS framework and implementing a complete theming system (light/dark/system) with zero flash on startup. The codebase currently uses custom CSS with CSS variables and has no Tailwind or theme provider in place.

**Key planning insights:**
1. **Current styling baseline:** Custom CSS with CSS variables (src/index.css), Radix UI components unstyled
2. **Theme persistence:** Must extend AppSettings model in Rust to store theme preference
3. **Flash prevention:** Requires Tauri window preload hook to inject theme before UI renders
4. **Tailwind configuration:** Minimal config with default breakpoints, container queries plugin, and CSS variables for colors
5. **No breaking changes needed** — existing CSS can coexist with Tailwind during migration

---

## Part 1: Current State Analysis

### Existing Styling Infrastructure

**CSS Files (9 total):**
- `src/index.css` — Global styles + CSS variable definitions for light theme
- `src/App.css` — App layout and button styles
- `src/styles/` directory contains component-specific CSS (6 files):
  - TaskForm.css, TaskModal.css, KanbanBoard.css, ExecutionHistory.css, TaskDetail.css, ImportSettings.css, ProjectSettingsModal.css

**CSS Variable Palette (light theme only):**
```css
--primary-color: #0066cc
--bg-primary: #ffffff
--bg-secondary: #f5f5f5
--text-primary: #000000
--text-secondary: #666666
--border-color: #dddddd
--hover-color: #eeeeee
--accent-color: #0066cc
--accent-hover: #0052a3
```

**Current Dependencies:**
- @radix-ui/react-dialog (unstyled)
- @radix-ui/react-select (unstyled)
- sonner (toast library with dark mode support via CSS class)
- xterm + xterm addons (terminal, has own CSS)
- @git-diff-view/react (syntax highlighted diffs)
- @dnd-kit/* (drag-drop, unstyled)

**No CSS Framework Present:**
- No Tailwind CSS installed
- No CSS-in-JS solution (Styled Components, Emotion, etc.)
- No theme provider (next-themes not installed)
- No build-time CSS preprocessing

### AppSettings Model (Rust)

**Current Model** (`src-tauri/src/models/settings.rs`):
```rust
pub struct AppSettings {
    pub project_path: Option<String>,
    pub recent_projects: Vec<String>,
    pub model_default: String,
    pub mcp_allowlist: Vec<String>,
    pub skills_default: Vec<String>,
    pub updated_at: String,
}
```

**Database Storage:** Settings table (key-value pairs)
- Currently stores 5 settings: project_path, recent_projects, model_default, mcp_allowlist, skills_default
- No theme field — will need to be added

**Settings Load/Save Flow:**
- `load_settings()` reads from settings table, reconstructs struct, returns defaults if empty
- `save_settings()` serializes vec fields to JSON, performs INSERT OR REPLACE in transaction
- TypeScript bindings auto-generated via ts-rs

### Tauri Configuration

**Current Setup:**
- vite.config.ts has no plugin configuration (just React plugin)
- main.rs handles database init, IPC command registration, app state management
- No window preload script or initialization hooks
- Window created via standard Tauri builder (likely in tauri.conf.json)

---

## Part 2: Tailwind CSS 4.1 Integration

### Installation & Configuration

**What needs to be installed:**
```bash
# Tailwind CSS 4.1 with vite plugin
pnpm add -D tailwindcss@latest @tailwindcss/vite
```

**Why these versions:**
- Tailwind CSS 4.1+ has built-in dark mode support
- @tailwindcss/vite replaces PostCSS-based build (simpler Vite integration)
- Vite plugin handles CSS processing automatically in dev and prod

**Configuration File** (`tailwind.config.ts`):

Per phase decisions, must include:
- **Content paths:** All src/**.{ts,tsx} files
- **Dark mode:** `darkMode: 'class'` (toggled by adding/removing class on root element)
- **Color palette:** ALL colors from CSS variables, NO hard-coded extensions
- **Animation utilities:** Enable default Tailwind animations (animate-pulse, animate-spin)
- **Container queries:** Enable @container plugin
- **Default settings:** Use default breakpoints (sm/md/lg/xl/2xl) only
- **No class prefix:** Standard Tailwind class names
- **No safelist:** All classes in JSX templates

**Minimal tailwind.config.ts structure:**
```typescript
import type { Config } from 'tailwindcss'

export default {
  darkMode: 'class',
  content: [
    './src/**/*.{ts,tsx}',
    './index.html',
  ],
  theme: {
    extend: {
      colors: {
        // All colors via CSS variables
        primary: 'var(--primary)',
        'primary-foreground': 'var(--primary-foreground)',
        // ... (see Part 3 for complete list)
      },
    },
  },
  plugins: [
    require('@tailwindcss/container-queries'),
  ],
} satisfies Config
```

### CSS Directives

**Update `src/index.css`** with Tailwind directives at the top:
```css
@import "tailwindcss";

/* Rest of existing CSS follows... */
```

The `@import "tailwindcss"` automatically includes:
- @tailwindcss/base (Preflight CSS resets)
- @tailwindcss/components
- @tailwindcss/utilities

**Result:** Tailwind utilities available in all JSX files, existing CSS variables continue to work.

### Vite Integration

**Update `vite.config.ts`:**
```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  // ... rest of config unchanged
}));
```

**Why this works:**
- @tailwindcss/vite processes CSS at dev time and build time
- No PostCSS config needed
- Works seamlessly with Vite's hot module replacement

---

## Part 3: Theme System Implementation

### CSS Variables Architecture

**Goal:** Complete theme on startup before window render, support light/dark/system theme.

**CSS Variables Required** (in both light & dark variants):

**Semantic Colors (semantic naming for easier theming):**
```css
/* Light theme (in :root) */
--background: #ffffff
--foreground: #000000
--primary: #0066cc
--primary-foreground: #ffffff
--secondary: #6c757d
--secondary-foreground: #ffffff
--muted: #e9ecef
--muted-foreground: #6c757d
--accent: #0066cc
--accent-foreground: #ffffff
--destructive: #dc3545
--destructive-foreground: #ffffff
--border: #dee2e6
--input: #ffffff
--ring: #0066cc
```

**Dark theme (in html.dark):**
```css
/* Dark theme - typically inverted */
--background: #1a1a1a
--foreground: #ffffff
--primary: #3b82f6
--primary-foreground: #000000
/* ... etc for each color */
```

**System accent colors** (can be injected during preload):
```css
--system-accent: /* Detected from OS at startup */
```

### Theme Provider Implementation

**New file: `src/providers/ThemeProvider.tsx`**

Responsibilities:
1. Detect initial theme preference (from settings or system)
2. Apply theme class to document root (`<html class="dark">` or nothing for light)
3. Persist changes to database via IPC
4. Provide context hook for components to read/change theme

**Structure:**
```typescript
import { createContext, useContext, useEffect, useState } from 'react'
import { invoke } from '../lib/tauri-mock'
import type { AppSettings } from '../types/bindings'

type ThemeValue = 'light' | 'dark' | 'system'

interface ThemeContextValue {
  theme: ThemeValue
  setTheme: (theme: ThemeValue) => Promise<void>
  systemTheme: 'light' | 'dark' // Current OS theme (read once at startup)
}

export const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeValue>('system')
  const [systemTheme, setSystemTheme] = useState<'light' | 'dark'>('light')
  const [isReady, setIsReady] = useState(false)

  // Initialize theme on mount
  useEffect(() => {
    async function initTheme() {
      try {
        const settings = await invoke<AppSettings>('get_settings')
        const savedTheme = (settings.theme_preference || 'system') as ThemeValue

        // Detect system theme once at startup
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
        const detected = prefersDark ? 'dark' : 'light'
        setSystemTheme(detected)

        // Apply initial theme
        applyTheme(savedTheme, detected)
        setThemeState(savedTheme)
      } catch (err) {
        console.error('Failed to load theme settings:', err)
        // Fallback to system
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
        setSystemTheme(prefersDark ? 'dark' : 'light')
        applyTheme('system', prefersDark ? 'dark' : 'light')
      } finally {
        setIsReady(true)
      }
    }

    initTheme()
  }, [])

  // Apply theme to DOM
  function applyTheme(theme: ThemeValue, systemTheme: 'light' | 'dark') {
    const effectiveTheme = theme === 'system' ? systemTheme : theme
    const htmlElement = document.documentElement

    if (effectiveTheme === 'dark') {
      htmlElement.classList.add('dark')
    } else {
      htmlElement.classList.remove('dark')
    }
  }

  // Handle theme change
  async function handleSetTheme(newTheme: ThemeValue) {
    setThemeState(newTheme)

    // Apply to DOM immediately
    applyTheme(newTheme, systemTheme)

    // Persist to database
    try {
      const settings = await invoke<AppSettings>('get_settings')
      const updated: AppSettings = {
        ...settings,
        theme_preference: newTheme,
        updated_at: new Date().toISOString(),
      }
      await invoke('save_settings', { settings: updated })
    } catch (err) {
      console.error('Failed to save theme preference:', err)
    }
  }

  if (!isReady) {
    return <>{children}</> // Render children while loading (no flash if CSS preload works)
  }

  return (
    <ThemeContext.Provider value={{ theme, setTheme: handleSetTheme, systemTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme must be used within ThemeProvider')
  }
  return context
}
```

**Integration in App.tsx:**
```typescript
import { ThemeProvider } from './providers/ThemeProvider'

function App() {
  // ... existing component logic

  return (
    <ThemeProvider>
      {/* Existing app content */}
    </ThemeProvider>
  )
}
```

### Flash Prevention Strategy

**Challenge:** Tailwind CSS loads with @import, CSS variables apply via JS — if JS runs after render, there's a visible flash.

**Solution:** Tauri window preload with theme injection

**File: `src-tauri/src/preload/theme.js`** (new, small script)
```javascript
// Runs before window content renders
(function() {
  try {
    // Try to read persisted theme from IPC (won't work in preload)
    // Instead, detect system theme which is synchronous
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

    // Apply class immediately (before DOM render)
    if (prefersDark) {
      document.documentElement.classList.add('dark');
    }

    // CSS variables will be read by stylesheet via :root and html.dark
  } catch (e) {
    // Silent fail, light theme is default
  }
})();
```

**Integration in Tauri:** Update main.rs to inject script on window creation
```rust
.setup(|app| {
  let main_window = app.get_webview_window("main").unwrap();

  // Inject preload script that sets theme class before DOM renders
  main_window.eval("... execute preload/theme.js ...")?;

  Ok(())
})
```

**Why this prevents flash:**
1. Browser reads preload script synchronously before rendering
2. Class is added to html element before CSS processes styles
3. Dark mode CSS variables apply immediately
4. By the time React renders, theme is already applied
5. JavaScript can later refine with database-persisted preference

---

## Part 4: Database & IPC Changes

### Rust Model Update

**Modify `src-tauri/src/models/settings.rs`:**

```rust
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AppSettings {
    pub project_path: Option<String>,
    pub recent_projects: Vec<String>,
    pub model_default: String,
    pub mcp_allowlist: Vec<String>,
    pub skills_default: Vec<String>,
    pub theme_preference: Option<String>,  // NEW: 'light' | 'dark' | 'system'
    pub updated_at: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            project_path: None,
            recent_projects: Vec::new(),
            model_default: "claude-opus-4-5".to_string(),
            mcp_allowlist: Vec::new(),
            skills_default: Vec::new(),
            theme_preference: Some("system".to_string()),  // NEW
            updated_at: chrono::Utc::now().to_rfc3339(),
        }
    }
}
```

### Settings Persistence

**Modify `src-tauri/src/db/settings.rs`:**

Add theme_preference to load/save logic:
```rust
pub fn load_settings(conn: &Connection) -> Result<AppSettings, AppError> {
    // ... existing code ...

    let theme_preference = settings_map
        .get("theme_preference")
        .cloned();

    // ... build AppSettings with theme_preference field
}

pub fn save_settings(conn: &mut Connection, settings: &AppSettings) -> Result<(), AppError> {
    // ... existing code ...

    let pairs = vec![
        // ... existing pairs ...
        ("theme_preference", settings.theme_preference.as_ref().map(|s| s.as_str()).unwrap_or("system")),
    ];

    // ... rest of save logic
}
```

**Result:** Theme preference persisted in SQLite settings table

### TypeScript Bindings

After Rust changes, run:
```bash
cargo build --lib
```

This auto-generates:
```typescript
// src/types/bindings.ts
export type AppSettings = {
  project_path: string | null;
  recent_projects: string[];
  model_default: string;
  mcp_allowlist: string[];
  skills_default: string[];
  theme_preference: string | null;
  updated_at: string;
}
```

---

## Part 5: Settings UI Integration

### Theme Toggle in ProjectSettingsModal

**Location:** `src/components/ProjectSettingsModal.tsx` (existing component, extend it)

**Add theme selector to form:**
```typescript
interface ProjectSettingsFormData {
  model_default: string;
  mcp_servers: Record<string, boolean>;
  skills: Record<string, boolean>;
  theme_preference: string;  // NEW
}

// In form JSX, add fieldset:
<fieldset className="form-fieldset">
  <legend>Appearance</legend>
  <select {...register("theme_preference")} className="form-select">
    <option value="light">Light</option>
    <option value="dark">Dark</option>
    <option value="system">System</option>
  </select>
</fieldset>
```

**On change:** useTheme().setTheme() updates immediately + persists

**Notes:**
- Per phase decisions: **Settings page only** (no header toggle)
- **Text labels only** (no sun/moon icons)
- **No toast notification** on theme change
- **Select/dropdown control type** (not radio buttons)

---

## Part 6: Implementation Order & Dependencies

### Phase Dependencies
- **Depends on:** Phase 13 (bug fixes complete, mock code isolated)
- **Required before:** Phase 15+ (UI redesign uses Tailwind)

### Implementation Sequence

1. **Install Tailwind CSS 4.1 + @tailwindcss/vite**
   - Add to package.json devDependencies
   - Run pnpm install

2. **Create tailwind.config.ts**
   - Minimal config with CSS variable colors
   - Enable container queries plugin
   - Content paths pointing to src/**/*.{ts,tsx}

3. **Update vite.config.ts**
   - Add @tailwindcss/vite plugin

4. **Create CSS variables theme**
   - Expand src/index.css with complete color palette
   - Add dark mode variants
   - Ensure both :root and html.dark coverage

5. **Create ThemeProvider**
   - src/providers/ThemeProvider.tsx
   - useTheme() hook
   - Theme context

6. **Update Rust models**
   - Add theme_preference to AppSettings
   - Update settings.rs load/save
   - Rebuild to regenerate TypeScript bindings

7. **Create preload script**
   - src-tauri/src/preload/theme.js
   - Window preload hook in main.rs

8. **Integrate ThemeProvider in App**
   - Wrap app with <ThemeProvider>

9. **Add theme toggle to ProjectSettingsModal**
   - Add theme_preference field to form
   - Test persistence across restarts

10. **Test full flow**
    - Start app, verify no flash
    - Toggle theme, verify immediate update
    - Restart app, verify theme persists
    - Check system theme detection

---

## Part 7: Technical Decisions & Trade-offs

### Why next-themes?
**Decided: NO** — too complex for Tauri (designed for Next.js). Instead:
- Simple React context (lighter weight)
- Direct DOM manipulation for class toggling
- Tauri IPC for persistence

### Why @tailwindcss/vite instead of PostCSS?
**Decided: YES** — vite-native approach:
- No PostCSS config needed
- Faster dev server startup
- Automatic CSS optimization in production

### Why CSS variables instead of Tailwind theme extension?
**Phase decision:** ALL colors from CSS variables, no hard-coded Tailwind colors
- Reason: Easier to swap themes at runtime
- Single source of truth for color palette
- Compatible with dynamic system accent detection

### Why read system theme only once?
**Phase decision:** "Read OS theme on startup only — no real-time tracking"
- Reason: Avoids watchers, simpler implementation
- Trade-off: System theme changes mid-session ignored (acceptable)

### Why no safelist?
**Phase decision:** "No safelist configuration — all classes appear in JSX/TSX templates"
- Reason: Ensures all used utilities are scanned by Tailwind
- Eliminates dead code and keeps bundle small

---

## Part 8: Known Gaps & Open Questions

### Claude's Discretion Areas (need detailed investigation)

1. **Exact Tailwind color values for dark theme**
   - Current light palette exists
   - Need to define dark variants (inverted contrast ratios)
   - Recommendation: Use Tailwind's default gray scale (gray-50 to gray-950) and adjust primary accent

2. **Tauri preload implementation specifics**
   - How to inject script before window render?
   - Options:
     a) Use Tauri's window.setup() hook with eval()
     b) Include in index.html via <script> tag
     c) Use webview initialization in Rust via window.eval()
   - Recommend: Option (c) in main.rs builder

3. **Container queries plugin usage**
   - Phase specifies enabling @container plugin
   - Need to identify components that need container query responsive design
   - Likely candidates: Split panes (ExecutionTerminal + DiffViewer), card grids

4. **Sonner toast styling in dark mode**
   - Sonner already has dark mode support (checks .dark class)
   - May need custom CSS for brand colors
   - Verify in testing

5. **Radix UI component styling**
   - Radix components currently unstyled (no CSS framework)
   - Phase 15 (UI redesign) will likely add shadcn/ui components
   - Phase 14 leaves Radix as-is, just ensures theming capability

### Validation Gaps

- **No current test for flash:** Need to verify preload runs before React
- **System theme detection:** matchMedia('(prefers-color-scheme: dark)') works on all platforms
- **CSS variables fallback:** What if a variable is undefined? (should use Tailwind defaults)

---

## Part 9: References & Resources

### Tailwind CSS 4.1
- Migration guide: Tailwind v4 changes (no more postcss plugin)
- Container queries: @tailwindcss/container-queries plugin
- Dark mode class strategy: https://tailwindcss.com/docs/dark-mode

### Tauri Integration
- Window setup hooks: Tauri Manager trait
- Preload scripts: tauri::invoke, window.eval()
- Platform-specific CSS: media queries or @supports rules

### next-themes (reference, not used)
- Code pattern: ThemeProvider wrapping app + useTheme hook
- Adapted for Tauri context (simpler, no localStorage complexity)

### CSS Architecture
- Variable naming convention: HSL-based (easier theme switching)
- Dark mode strategy: class-based (not media query) for manual override

---

## Part 10: Success Criteria Checklist

These must ALL be true by phase completion:

- [ ] Tailwind CSS 4.1 installed and @tailwindcss/vite configured
- [ ] tailwind.config.ts has correct content paths, plugins, dark mode settings
- [ ] src/index.css includes @import "tailwindcss" directive
- [ ] CSS variables defined for both light (:root) and dark (html.dark) themes
- [ ] ThemeProvider component created and integrated in App.tsx
- [ ] useTheme() hook allows components to read/set theme
- [ ] AppSettings model extended with theme_preference field
- [ ] Rust settings.rs load/save handles theme_preference correctly
- [ ] TypeScript bindings regenerated with new theme_preference field
- [ ] Tauri preload script injected to apply theme before window renders
- [ ] ProjectSettingsModal includes theme toggle (Select dropdown, text labels)
- [ ] Theme change persists across app restarts
- [ ] System theme detection works on all platforms
- [ ] No visual flash on app startup (even with dark theme set)
- [ ] Tailwind utilities available in all components (verify with test class)
- [ ] Container queries @container utilities functional
- [ ] All tests passing (Rust cargo test, no new TypeScript errors)

---

## Part 11: Implementation Risks & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| CSS variable fallback undefined | Low | Visual breakage if variable missing | Use Tailwind safelist or hardcode fallbacks |
| Preload runs after DOM render | Medium | Flash of light theme | Test in both dev/prod, use window.eval timing |
| System theme detection fails | Low | Default to light theme | Wrap in try/catch, have light as fallback |
| Database migration fails | Low | Settings lost | Test with fresh database + existing data |
| Tailwind scanning misses classes | Low | Missing utilities | Disable safelist per phase decision, scan all files |
| Tauri IPC race condition on startup | Low | Theme not persisted | Debounce setTheme calls, use transaction in DB |

---

## Conclusion

Phase 14 is well-scoped and achievable with the decisions from the phase discussion. The key technical challenge is **flash prevention**, which requires:
1. Tauri window preload to set theme class before React renders
2. CSS variable structure supporting both light and dark themes
3. Efficient startup detection of system theme preference

The implementation is low-risk because:
- Tailwind is standard, widely-documented framework
- Theme switching via CSS class is industry-standard pattern
- Existing CSS can coexist during migration
- No breaking changes to component APIs
- TypeScript bindings auto-generate from Rust

Next step: Proceed to planning phase to break work into tasks and determine effort estimation.

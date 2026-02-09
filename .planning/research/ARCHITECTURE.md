# Architecture: Tailwind 4 + shadcn/ui + Theming in Tauri 2 React

**Domain:** UI framework migration in Tauri desktop apps
**Researched:** 2026-02-09
**Confidence:** HIGH (Tailwind 4 + Vite well-documented, shadcn patterns established, Tauri integration straightforward)

## Standard Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      React Components Layer                      │
├─────────────────────────────────────────────────────────────────┤
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐ │
│  │  shadcn/   │  │  Custom    │  │   Radix    │  │   Sonner   │ │
│  │    Button  │  │ Components │  │   Dialog   │  │   Toasts   │ │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘ │
│        │                │               │               │        │
├────────┴────────────────┴───────────────┴───────────────┴────────┤
│              Tailwind + CSS Modules Layer                         │
├─────────────────────────────────────────────────────────────────┤
│  ┌───────────────────┐  ┌──────────────────┐  ┌────────────┐    │
│  │  Tailwind Utilities│  │  Component.module.css  │ Theme  │    │
│  │  (generated at    │  │  (Kanban, Terminal,  │  CSS    │    │
│  │   build time)     │  │   etc.)            │ Vars    │    │
│  └───────────────────┘  └──────────────────┘  └────────────┘    │
├─────────────────────────────────────────────────────────────────┤
│                    Theme Provider Layer                          │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────┐   │
│  │     ThemeProvider (next-themes)                           │   │
│  │  - Manages light/dark/system modes                        │   │
│  │  - Persists preference to localStorage                    │   │
│  │  - Applies data-theme attribute to <html>                │   │
│  └──────────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────┤
│                   Build & Configuration Layer                    │
├─────────────────────────────────────────────────────────────────┤
│  ┌────────────────────┐  ┌─────────────────┐  ┌──────────────┐  │
│  │  Vite + @tailwindcss  │  │  PostCSS        │  │  tailwind.   │  │
│  │     /vite plugin       │  │  (optional)     │  │  config.ts   │  │
│  └────────────────────┘  └─────────────────┘  └──────────────┘  │
│                                                                   │
│  ┌────────────────────┐  ┌─────────────────┐  ┌──────────────┐  │
│  │  components.json   │  │  index.css      │  │  App.css     │  │
│  │  (shadcn config)   │  │  (@import       │  │  (theme      │  │
│  │                    │  │   tailwindcss)  │  │   overrides) │  │
│  └────────────────────┘  └─────────────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Implementation |
|-----------|----------------|-----------------|
| React Components | UI rendering, event handling, state binding | Traditional TSX components |
| shadcn/ui | Pre-built, accessible, headless components | Copy-to-project components with Tailwind |
| Tailwind Utilities | Layout, spacing, typography, colors | CSS class names on elements |
| CSS Modules | Component-specific one-off styles | `.css` files alongside components |
| ThemeProvider | Theme state management, persistence, OS detection | next-themes library wrapper |
| Vite + @tailwindcss/vite | CSS generation, hot module reload, build output | Compile Tailwind to CSS at dev/build time |
| PostCSS (optional) | Plugin pipeline for CSS transformations | Only needed for advanced features beyond Tailwind |

## Recommended Project Structure

```
src/
├── components/
│   ├── ui/                         # shadcn components (copy from CLI)
│   │   ├── button.tsx
│   │   ├── dialog.tsx
│   │   ├── select.tsx
│   │   └── [...]
│   ├── KanbanBoard.tsx             # App-specific components
│   ├── KanbanBoard.module.css      # Component-scoped styles (if needed)
│   ├── TaskCard.tsx
│   ├── TaskCard.module.css
│   ├── ProjectPicker.tsx
│   ├── ProjectSettingsModal.tsx
│   └── [...]
├── store/
│   └── boardStore.ts              # Zustand state management
├── styles/
│   ├── index.css                  # Root: @import "tailwindcss"
│   ├── App.css                    # App-level CSS variables, theme overrides
│   └── globals.css                # (Optional) shared utility classes
├── types/
│   └── bindings.ts                # Auto-generated from Rust
├── lib/
│   └── [utilities]
├── App.tsx                        # Root wrapped with ThemeProvider
└── main.tsx                       # App mount point
```

### Structure Rationale

- **`components/ui/`:** Separate shadcn components to clarify they're third-party. Enables bulk updates or replacement.
- **`components/`:** App-specific components stay at this level, not nested deeper (flatter structure for easier imports).
- **`.module.css` files:** Colocated with components. CSS Modules prevent naming conflicts, improve maintainability for one-off styles.
- **`styles/index.css`:** Single entry point for Tailwind. All theme configuration and global utilities here.
- **`App.tsx` root level:** ThemeProvider wraps entire app, enabling theme context everywhere.

## Architectural Patterns

### Pattern 1: Tailwind + CSS Modules (Hybrid)

**What:** Use Tailwind utilities for layout/spacing, CSS Modules for component-specific styles that need scoping or complexity.

**When to use:**
- Most of the time — Tailwind for 90% of styling
- CSS Modules only when: component has complex state-based styles, needs animation definitions, or has BEM-like naming

**Trade-offs:**
- Pro: Best of both worlds — utility speed with scoped safety
- Pro: Easy to refactor — delete `.module.css` when component simplifies
- Con: Two parallel style systems to maintain
- Con: Slight build complexity for dual pipelines

**Example:**
```typescript
// KanbanBoard.tsx
import styles from "./KanbanBoard.module.css";

export function KanbanBoard() {
  return (
    <div className="flex h-screen gap-4 bg-background p-4">
      {/* Tailwind for layout */}
      <div className={styles.column}>
        {/* CSS Modules for component-specific animation */}
        Backlog
      </div>
    </div>
  );
}
```

```css
/* KanbanBoard.module.css */
.column {
  animation: slideIn 0.3s ease-out;
}

@keyframes slideIn {
  from { opacity: 0; transform: translateX(-10px); }
  to { opacity: 1; transform: translateX(0); }
}
```

### Pattern 2: Theme Provider at Root

**What:** Wrap entire app with `<ThemeProvider>` at the topmost level to enable `useTheme` hook throughout component tree.

**When to use:** Always — this is the foundation for theme switching.

**Trade-offs:**
- Pro: Single source of truth for theme state
- Pro: Avoids prop drilling for theme
- Con: Adds one wrapper component to React tree
- Con: SSR complications (mitigated in Tauri — no SSR)

**Example:**
```typescript
// App.tsx
import { ThemeProvider } from "next-themes";

export function App() {
  return (
    <ThemeProvider
      attribute="data-theme"
      defaultTheme="system"
      enableSystem
      storageKey="app-theme"
    >
      {/* All components here have access to useTheme() */}
      <KanbanBoard />
    </ThemeProvider>
  );
}

// Inside any nested component
import { useTheme } from "next-themes";

function Settings() {
  const { theme, setTheme } = useTheme();
  return (
    <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
      Toggle theme
    </button>
  );
}
```

### Pattern 3: CSS Variables for Colors (Tailwind 4 Native)

**What:** Define theme colors as CSS variables using `@theme` directive. Tailwind 4 automatically exposes all theme tokens as CSS variables.

**When to use:** Always in Tailwind 4. Replaces separate theme config files.

**Trade-offs:**
- Pro: Colors update dynamically without rebuilding
- Pro: Simpler to override specific tokens
- Pro: CSS-in-CSS (no JavaScript theme config needed)
- Con: Requires Tailwind 4+ (breaking change from v3)

**Example:**
```css
/* src/styles/index.css */
@import "tailwindcss";

@theme {
  --color-primary-500: oklch(0.62 0.22 257.65);
  --color-success-500: oklch(0.71 0.13 142.48);
  --color-destructive-500: oklch(0.63 0.26 29.23);
}
```

### Pattern 4: Data-Attribute Dark Mode (Tauri-Friendly)

**What:** Use `data-theme` attribute (instead of class) on `<html>` for theme switching. Works better in Tauri without SSR complexity.

**When to use:** In Tauri (and any non-SSR context). Simpler than class strategy.

**Trade-offs:**
- Pro: Avoids SSR hydration mismatches (none in Tauri anyway)
- Pro: Cleaner CSS selectors with data attributes
- Con: Class strategy is more common in web
- Con: Requires custom CSS variant in Tailwind

**Example:**
```css
/* src/styles/App.css */
/* Override Tailwind's dark variant to use data attribute */
@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));
```

```typescript
// ThemeProvider configuration in App.tsx
<ThemeProvider
  attribute="data-theme"
  values={{
    light: "light",
    dark: "dark",
    system: "system"
  }}
>
```

### Pattern 5: Incremental Component Migration

**What:** Convert existing components to shadcn one-by-one, keeping old CSS files until replacement is complete.

**When to use:** During migration phase (Phase 1 of roadmap).

**Trade-offs:**
- Pro: Reduces risk — test each component change independently
- Pro: Keeps app working throughout migration
- Con: Temporary code duplication
- Con: Two component libraries in use simultaneously

**Example Migration Path:**
```
Week 1: TaskCard → shadcn Button + Card
  - Old: TaskCard.tsx uses .css file
  - New: KanbanBoard now imports shadcn Button
  - Delete: TaskCard.css after full migration

Week 2: KanbanBoard columns → shadcn Card
  - Old: Custom column divs
  - New: shadcn Card wrapper
  - CSS Modules for drag-drop animations stay

Week 3: Modals → shadcn Dialog
  - Old: Custom modal divs with Radix
  - New: shadcn Dialog (built on Radix already)
  - Seamless switch — same underlying library
```

## Data Flow

### Theme State Flow

```
User clicks "Dark mode" toggle
    ↓
useTheme().setTheme("dark") called
    ↓
ThemeProvider updates state + localStorage
    ↓
data-theme="dark" applied to <html>
    ↓
CSS dark: variants activate globally
    ↓
Component re-renders with dark colors
    ↓
CSS variables reflect dark theme
```

### Style Resolution Order (Highest to Lowest Priority)

```
1. Inline styles (avoid)
   ↓
2. CSS Modules (.module.css)
   ↓
3. Component-scoped CSS (imported .css files)
   ↓
4. Tailwind utilities (class names)
   ↓
5. Global CSS (App.css, index.css)
   ↓
6. Browser defaults
```

### Build-Time CSS Generation

```
.tsx files written by developer
    ↓
Vite scans for class names (e.g., "p-4 bg-background")
    ↓
@tailwindcss/vite plugin intercepts
    ↓
Generates matching CSS rules (p-4 → padding: 1rem, etc.)
    ↓
CSS written to bundle
    ↓
Browser receives optimized stylesheet (only used classes)
```

### Component Import Flow (shadcn)

```
Developer runs: pnpm dlx shadcn@latest add button
    ↓
CLI reads components.json config
    ↓
Downloads button.tsx from registry
    ↓
Copies to src/components/ui/button.tsx
    ↓
Developer imports: import { Button } from "@/components/ui/button"
    ↓
Button renders with project's Tailwind tokens
    ↓
(No npm dependency — code is yours to modify)
```

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| Single user (MVP) | Tailwind + shadcn + next-themes handles everything. No database needed for theme (localStorage sufficient). |
| 100s of users | Theme data moves to database (if app stores user preferences server-side for future cloud features). CSS bundle stable — Tailwind outputs same file regardless of user count. |
| 1000s of users | Consider lazy-loading shadcn components if using 50+ components. Tree-shake unused Tailwind utilities (already automatic with Vite). |
| 10k+ users | CSS-in-JS optional if dynamic theming needed beyond light/dark. Current approach scales fine. |

### Scaling Priorities

1. **First optimization:** Lazy-load shadcn components (use dynamic imports for modals, settings) — biggest impact on initial load.
2. **Second optimization:** CSS critical path inlining (Vite does this automatically) — ensures no flash of unstyled content.
3. **Third optimization:** Theme persistence via Tauri store (instead of localStorage) — survives app updates.

## Tauri-Specific Considerations

### Challenge 1: No SSR (Actually an Advantage)

**Problem in web apps:** Flash of wrong theme on initial page load because theme CSS loads after JavaScript hydrates.

**Solution in Tauri:** No server-side rendering exists. App always renders client-side. `next-themes` script runs before React renders. **No flash possible.**

**Implementation:** Use `disableTransitionOnChange={false}` safely in Tauri (transitions won't appear jarring since no hydration mismatch).

```typescript
<ThemeProvider
  attribute="data-theme"
  defaultTheme="system"
  enableSystem
  disableTransitionOnChange={false}  // Safe in Tauri
>
```

### Challenge 2: Vite HMR in Dev Mode

**Problem:** Vite dev server needs to hot-reload CSS when theme changes.

**Solution:** Already configured in vite.config.ts. Tauri plugin handles this.

**Verification:** In `vite.config.ts`, HMR port is 5174 (different from 5173):
```typescript
hmr: host
  ? { protocol: "ws", host, port: 5174 }
  : undefined,
```

### Challenge 3: Theme Persistence Beyond localStorage

**Problem:** localStorage is not ideal for desktop apps (could be lost on app update, not Tauri-aware).

**Solution Option 1 (recommended):** Use Tauri's `@tauri-apps/plugin-store` for persistent theme.

```typescript
import { Store } from "@tauri-apps/plugin-store";

const store = new Store(".preferences.dat");

// On app init
const savedTheme = await store.get("theme") || "system";
setTheme(savedTheme);

// On theme change
await store.set("theme", newTheme);
await store.save();
```

**Solution Option 2:** Keep localStorage (simpler, sufficient for MVP).

## Anti-Patterns

### Anti-Pattern 1: Tailwind config bloat (v3 mistake, avoid in v4)

**What people do:** Define every custom color in `tailwind.config.js` (v3 approach).

**Why it's wrong:** Tailwind 4 uses CSS-first `@theme` directives. Old approach defeats simplicity advantage of v4.

**Do this instead:**
```css
/* src/styles/App.css - NOT tailwind.config.js */
@import "tailwindcss";

@theme {
  --color-brand-500: oklch(0.55 0.20 257);
}
```

### Anti-Pattern 2: CSS Modules for everything

**What people do:** Create `.module.css` files for every component, even simple layout ones.

**Why it's wrong:** Tailwind utilities are simpler and faster. Scoping not needed for layout classes.

**Do this instead:**
```typescript
// Good: Use Tailwind for layout
export function Card() {
  return <div className="rounded-lg border p-4 shadow-sm">...</div>;
}

// Bad: Unnecessary scoping
// Card.module.css with .card { border-radius: 0.5rem; ... }
```

### Anti-Pattern 3: Global CSS with theme colors

**What people do:** Hard-code colors in global CSS (e.g., `body { background: #ffffff; }`).

**Why it's wrong:** Doesn't update when theme changes. Defeats dark mode.

**Do this instead:**
```css
/* App.css */
body {
  background-color: hsl(var(--background) / <alpha-value>);
  color: hsl(var(--foreground) / <alpha-value>);
}
```

### Anti-Pattern 4: Class-based dark mode in Tauri

**What people do:** Use `className="dark"` toggle on `<html>` (web convention).

**Why it's wrong:** Works, but Tauri renders consistently. Data attributes are cleaner and prevent naming conflicts.

**Do this instead:**
```typescript
// Use data-theme attribute (cleaner for desktop apps)
<html data-theme="dark">

// Not this:
<html className="dark">
```

### Anti-Pattern 5: Not migrating radix-ui components to shadcn

**What people do:** Keep Radix Dialog, Select, etc. and mix in shadcn.

**Why it's wrong:** Duplicate dependency, inconsistent styling, larger bundle.

**Do this instead:**
```typescript
// Existing code already uses Radix:
import { Dialog } from "@radix-ui/react-dialog";

// Replace with shadcn (which wraps Radix, same API):
import { Dialog, DialogContent } from "@/components/ui/dialog";
```

## Integration Points

### External Libraries

| Library | Integration Pattern | Notes |
|---------|---------------------|-------|
| shadcn/ui | Copy components to project, customize with Tailwind | No npm dependency — CLI-based setup |
| Tailwind CSS 4 | `@import "tailwindcss"` in CSS file | No config needed with @tailwindcss/vite |
| next-themes | Wrap app root with ThemeProvider | Works in non-Next.js React apps |
| PostCSS | Only if using advanced features (rarely needed) | Vite handles CSS bundling automatically |
| Radix UI | Already in project (shadcn built on it) | Keep for Dialog, Select. No conflicts. |
| Sonner | Toast library (compatible with all above) | Works with Tailwind styling |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Components ↔ Tailwind | CSS classes on JSX elements | One-way: component reads, Tailwind writes CSS |
| Components ↔ Theme Provider | useTheme hook | Two-way: read theme state, dispatch setTheme |
| Theme Provider ↔ localStorage | Automatic via next-themes | Transparent — no code needed |
| Vite ↔ @tailwindcss/vite | Plugin architecture | Automatic — plugin intercepts CSS imports |
| Dev server ↔ Browser | WebSocket (HMR port 5174) | Tauri + Vite handles automatically |

## Build Process

### Development (`pnpm tauri:dev`)

```
1. Vite starts on port 5173
2. @tailwindcss/vite plugin initializes
3. src/styles/index.css parsed (@import "tailwindcss")
4. Tailwind scans .tsx files for class names
5. CSS generated in-memory (not written to disk)
6. React components load with Tailwind utilities
7. Browser watches for changes (HMR port 5174)
8. Edit .tsx → Vite detects → CSS rescanned → Instant reload
9. Edit .css → Vite detects → CSS refreshed → Instant reload
```

### Production (`pnpm tauri build`)

```
1. TypeScript compiled to JavaScript
2. @tailwindcss/vite plugin runs full scan
3. Only used Tailwind utilities included in bundle
4. CSS minified and deduplicated
5. Output written to dist/assets/
6. Tauri bundles dist/ into .dmg/.exe/.AppImage
```

## Common Integration Issues

### Issue 1: Tailwind utilities not applying

**Symptom:** Class names in JSX but no styles appear.

**Cause:** CSS file not imported properly or Tailwind directive missing.

**Fix:**
```typescript
// App.tsx or entry point MUST import CSS
import "./styles/index.css";  // ← Include this

// src/styles/index.css MUST have:
@import "tailwindcss";  // ← Include this
```

### Issue 2: Dark mode not persisting across app restarts

**Symptom:** Theme reverts to light after closing/opening app.

**Cause:** Using localStorage alone (sufficient for web, not ideal for desktop).

**Fix:** Migrate to Tauri store:
```typescript
const store = new Store(".preferences.dat");
const savedTheme = await store.get("theme") || "system";
```

### Issue 3: CSS Modules conflict with Tailwind

**Symptom:** Module CSS works but Tailwind classes stop working in same component.

**Cause:** CSS Modules disabled in Vite by default for Tailwind apps.

**Fix:** Ensure vite.config.ts doesn't disable modules:
```typescript
export default defineConfig({
  css: {
    modules: { auto: /\.module\.css$/ }  // ← Enable for .module.css only
  },
  plugins: [
    tailwindcss(),
    react()
  ]
});
```

### Issue 4: shadcn components not styled

**Symptom:** shadcn components render but look unstyled (no colors, borders, etc.).

**Cause:** components.json not created or Tailwind not configured before running CLI.

**Fix:**
```bash
# 1. Set up Tailwind first:
npm install tailwindcss @tailwindcss/vite
# Update src/styles/index.css with @import "tailwindcss"

# 2. THEN set up shadcn:
pnpm dlx shadcn@latest init
pnpm dlx shadcn@latest add button
```

## Migration Checklist

- [ ] Install Tailwind 4 + @tailwindcss/vite + next-themes
- [ ] Update src/styles/index.css with `@import "tailwindcss"`
- [ ] Update vite.config.ts with `tailwindcss()` plugin
- [ ] Update App.tsx to wrap with `<ThemeProvider>`
- [ ] Run `pnpm dlx shadcn@latest init` to create components.json
- [ ] Add first shadcn component: `pnpm dlx shadcn@latest add button`
- [ ] Verify Tailwind utilities work: add `className="p-4 bg-background"` to test
- [ ] Replace first component (suggest: Button) with shadcn equivalent
- [ ] Set up theme toggle UI using `useTheme()` hook
- [ ] Test dark mode toggle in dev mode
- [ ] Update CSS Modules for components that need scoped styles
- [ ] Delete old CSS files as components migrate
- [ ] Test final build: `pnpm tauri build`

## Sources

- **Tailwind CSS 4 Documentation:** https://tailwindcss.com/docs (CSS-first configuration, @theme directive, @tailwindcss/vite plugin)
- **Tailwind CSS v4.0 Release Blog:** https://tailwindcss.com/blog/tailwindcss-v4 (major changes, 3.78x build speed improvement)
- **shadcn/ui Setup for Vite:** https://ui.shadcn.com/docs/installation/vite (components.json, manual component copying)
- **next-themes GitHub:** https://github.com/pacocoursey/next-themes (client-side theming, localStorage persistence, system preference detection)
- **Tailwind Dark Mode Docs:** https://tailwindcss.com/docs/dark-mode (class vs media strategy, @custom-variant)
- **Vite Config Documentation:** https://vite.dev/config/ (HMR, plugin architecture, CSS module configuration)

---
*Architecture research for: Tailwind 4 + shadcn/ui + theming integration in Tauri 2 React app*
*Researched: 2026-02-09*
*Confidence: HIGH — All major integration patterns validated against official documentation*

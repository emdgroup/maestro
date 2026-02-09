# Domain Pitfalls: UI Redesign with Tailwind + shadcn in Tauri

**Domain:** Migrating a functional Tauri desktop app UI from custom CSS to Tailwind CSS + shadcn/ui components

**Researched:** 2026-02-09

**Context:** GSD Agent Orchestrator is a working v1.0 product with custom CSS. Redesign must maintain functionality while improving aesthetics.

---

## Critical Pitfalls

Mistakes that cause rewrites, broken functionality, or require major rollbacks.

### Pitfall 1: Dynamic Class Names Purged by Tailwind Content Scanner

**What goes wrong:**

Tailwind scans source files for complete, static class name strings. If you construct class names dynamically at runtime, Tailwind won't detect them and removes them during build—resulting in unstyled elements in production.

**Why it happens:**

```tsx
// DANGER: This doesn't work
const statusColor = error ? 'text-red-600' : 'text-green-600';
<div className={`status-${statusColor}`}></div>

// DANGER: String interpolation
const bgColor = `bg-${color}-500`;
<div className={bgColor}></div>

// DANGER: Ternary with template strings
<div className={`${selected ? 'border-2' : 'border'} border-gray-300`}></div>
```

Tailwind's content scanner is a **text scanner, not a JavaScript parser**. It searches source files for complete character sequences matching the pattern `[a-z0-9]*:[a-z0-9\-]*` (simplified). If the string `text-red-600` never appears verbatim in your code, Tailwind doesn't generate it.

**Consequences:**

- Elements have no styling in production builds
- Works perfectly in development (because dev build includes ALL Tailwind classes)
- Fails silently—no build warnings
- Discovered only through QA or user reports
- Hard to debug: looks correct in dev, broken in production

**Prevention:**

1. **Always use static class names:**
```tsx
// GOOD: Complete class strings in source
<div className={error ? 'text-red-600' : 'text-green-600'}></div>

// GOOD: Complete strings in array
const classes = {
  success: 'text-green-600',
  error: 'text-red-600',
  warning: 'text-yellow-600',
};
<div className={classes[status]}></div>
```

2. **For dynamic utility values, use CSS variables + inline styles:**
```tsx
// GOOD: Use CSS variable with fallback
<div
  style={{ '--custom-color': color } as React.CSSProperties}
  className="text-[var(--custom-color)]"
>
</div>
```

3. **Safelist predictable values in config:**
```typescript
// tailwind.config.ts
export default {
  content: ['./src/**/*.{ts,tsx}'],
  safelist: [
    'text-red-600', 'text-green-600', 'text-blue-600', // status colors
    'bg-red-100', 'bg-green-100', 'bg-blue-100',
  ],
  theme: {},
}
```

**Detection:**

- Check browser DevTools: element has `class="..."` but no styling applied
- Run `pnpm build` and inspect output CSS file—missing classes won't be present
- Use Tailwind IntelliSense extension in VS Code—it will NOT autocomplete dynamic strings

**Phase to address:** Immediately during migration—audit all component files before build.

---

### Pitfall 2: Theme Flash on App Startup (FOUC in Desktop Context)

**What goes wrong:**

Tauri app starts with light theme (default), then dark theme CSS loads, causing visible flicker. User sees light UI briefly, then it switches to dark. Happens every app launch if theme detection runs in JavaScript (not CSS media query).

**Why it happens:**

```tsx
// DANGER: This flashes
useEffect(() => {
  // Dark mode detection happens AFTER render
  const isDark = localStorage.theme === 'dark' ||
    window.matchMedia('(prefers-color-scheme: dark)').matches;

  if (isDark) {
    document.documentElement.classList.add('dark');
  }
}, []);

// By this point, React has already rendered with default styles
// User sees light UI, then dark CSS kicks in
```

**Consequences:**

- Users see 100-500ms flash of wrong theme on startup
- Perceived as buggy or unprofessional
- Degrades UX even though functionality is correct
- More noticeable in desktop apps (no server-side rendering option like web)

**Prevention:**

1. **Inject theme detection in `<head>` BEFORE React renders:**

Create a script that runs synchronously in `index.html` `<head>`:

```html
<!-- index.html -->
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />

  <!-- CRITICAL: Theme script BEFORE React loads -->
  <script>
    (function() {
      const theme = localStorage.theme;
      const isDark = theme === 'dark' ||
        (!theme && window.matchMedia('(prefers-color-scheme: dark)').matches);

      if (isDark) {
        document.documentElement.classList.add('dark');
      }
    })();
  </script>

  <link rel="stylesheet" href="/src/index.css" />
</head>
```

2. **For Tauri: Use system theme detection on startup:**

```typescript
// App.tsx or similar initialization
useEffect(() => {
  // Tauri can query system preference
  invoke('get_system_theme').then((theme) => {
    localStorage.theme = theme;
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    }
  });
}, []);
```

3. **Configure Tailwind to use class-based theming:**

```typescript
// tailwind.config.ts
export default {
  darkMode: 'class', // Use .dark class, not prefers-color-scheme
  content: ['./src/**/*.{ts,tsx}'],
}
```

Then ensure the inline script above runs BEFORE React mounts.

**Detection:**

- Launch app multiple times, watch for flicker
- Open DevTools → Performance tab, record startup
- Check if `dark` class appears/disappears during render

**Phase to address:** Phase 1 (theming setup)—must be correct before components are built.

---

### Pitfall 3: CSS Conflicts Between Old Custom CSS and New Tailwind

**What goes wrong:**

Old custom CSS (KanbanBoard.css, TaskCard.css, etc.) conflicts with Tailwind utilities. Specificity wars: `.task-card { padding: 1rem; }` vs Tailwind's `p-4` fight over same elements. Result: unpredictable styling, overrides that don't work, element styling depends on load order.

**Why it happens:**

Your current code has ~10 CSS files with custom selectors, custom properties (`--bg-primary`), and specific styling. Tailwind generates utility classes with low specificity by design. When both target the same element:

```css
/* Old custom CSS - HIGHER specificity */
.task-card {
  padding: 1rem;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
}

/* Tailwind utilities - LOWER specificity */
.p-4 { padding: 1rem; }
.bg-white { background: white; }
.border { border: 1px solid; }
```

If Tailwind imports AFTER old CSS, Tailwind wins. If you mix them, debugging becomes a nightmare—you can't tell which rule is actually applied.

**Consequences:**

- Components styled half with Tailwind, half with custom CSS
- Hover/focus states don't work consistently
- Responsive breakpoints ignored in some components
- Color theming broken (CSS vars vs Tailwind tokens)
- Maintenance nightmare: which system owns this element?
- Refactoring one component breaks others unexpectedly

**Prevention:**

1. **Migrate in phases—don't mix systems in same component:**

Instead of:
```tsx
// BAD: Mixed systems
<div className="kanban-board p-4 dark:bg-gray-900">
  <div className="kanban-column bg-white shadow-md">
```

Do complete migration per component:
```tsx
// GOOD: Pure Tailwind
<div className="grid grid-cols-5 gap-4 p-4 dark:bg-gray-900">
  <div className="flex flex-col bg-white shadow-md">
```

2. **Rename old CSS files to `.migrate-old.css` (do not import):**

```typescript
// vite.config.ts
export default {
  css: {
    exclude: [/\.migrate-old\.css$/], // Exclude migrated CSS
  }
}
```

Keep them for reference, but don't load them. Prevents accidental conflicts.

3. **Use CSS layers to control specificity explicitly:**

```css
/* index.css */
@import "tailwindcss";
@layer components {
  /* Custom components that extend Tailwind */
  @apply flex flex-col gap-2;
}

@layer utilities {
  /* Custom utilities */
  .no-scrollbar::-webkit-scrollbar { display: none; }
}
```

4. **For mandatory custom CSS (animations, complex selectors):**

Use CSS modules with unique class names that don't conflict:

```tsx
// TaskCard.module.css
.taskCardContainer { /* specific naming */ }

// TaskCard.tsx
import styles from './TaskCard.module.css';
<div className={`${styles.taskCardContainer} flex gap-2`}>
```

**Detection:**

- Remove old CSS file, see what breaks
- DevTools: element shows multiple conflicting rules (orange flag = overridden)
- CSS specificity counter: should be low (Tailwind is intentionally low-specificity)
- Check cascade order: `@import "tailwindcss"` should come BEFORE custom CSS

**Phase to address:** Phase 1 (setup)—establish which CSS system owns which components.

---

### Pitfall 4: Content Configuration Missing or Incorrect for Tauri Build

**What goes wrong:**

Tailwind doesn't scan all your source files, so classes are purged from production builds. Works in dev, fails in production because Vite builds differently than dev server.

**Why it happens:**

Your `tailwind.config.ts` must tell Tailwind where to find class names:

```typescript
// tailwind.config.ts
export default {
  content: [
    './index.html',          // HTML file
    './src/**/*.{js,ts,jsx,tsx}', // React components
  ],
}
```

If this path is wrong or incomplete:
- Tailwind scans wrong directories
- Never finds your custom component files
- Purges their styles

Common miss: forgetting `index.html`, or using incorrect glob pattern.

**Consequences:**

- Build succeeds with no warnings
- Dev mode works (webpack serves everything)
- Production build is unstyled
- Appears as broken deployment

**Prevention:**

1. **Verify content config matches your file structure:**

```typescript
// tailwind.config.ts
export default {
  content: [
    './index.html',                    // Root HTML
    './src/**/*.{ts,tsx,jsx,js}',     // All React components
    './src/components/**/*.tsx',       // Explicit component path
    './src/**/*.module.css',           // CSS modules (for @apply rules)
  ],
  theme: {},
  plugins: [],
}
```

2. **Test production build locally:**

```bash
pnpm build
pnpm preview
```

Open in browser and verify all styling present. Check DevTools to confirm classes exist.

3. **In Tauri vite.config.ts, ensure CSS plugin loads Tailwind:**

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    tailwindcss(),  // CRITICAL: Must be present
    react(),
  ],
});
```

4. **Use `@source` directive in CSS to be explicit:**

```css
/* src/index.css */
@import "tailwindcss" source("./src");

@layer components {
  /* your custom components */
}
```

This tells Tailwind to only scan the `./src` directory, preventing it from missing files.

**Detection:**

- `pnpm build` then inspect `dist/` CSS files
- Search for specific class names: `grep "p-4" dist/style-*.css`
- If class is in component but not in built CSS, content config is wrong

**Phase to address:** Phase 1 (setup)—verify before writing components.

---

## Moderate Pitfalls

Mistakes that cause delays, technical debt, or compatibility issues.

### Pitfall 5: shadcn Component Assumptions About Path Aliases

**What goes wrong:**

shadcn/ui generates components with path aliases (`@/components/ui/button`). If your TypeScript `tsconfig.json` doesn't define the `@` alias correctly, imports break. Components copy-paste fails silently or errors at import time.

**Why it happens:**

When you run `pnpm dlx shadcn@latest init`, it assumes:

```typescript
// Expected tsconfig.json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

If this isn't configured, shadcn still generates components using `@/` imports, but TypeScript can't resolve them.

**Consequences:**

- `Cannot find module '@/components/ui/button'` errors
- Components added but unusable
- Type checking fails
- IDE autocomplete doesn't work

**Prevention:**

1. **Verify tsconfig.json aliases BEFORE running shadcn init:**

```bash
# Add @types/node first if using tsx with node
pnpm add -D @types/node
```

```typescript
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForKeyModule": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,

    // Path aliases REQUIRED
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    },

    "strict": true,
    "esModuleInterop": true,
    "moduleResolution": "bundler",
  }
}
```

2. **Configure vite.config.ts with matching alias:**

```typescript
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
```

3. **Run shadcn init AFTER verifying aliases work:**

```bash
pnpm dlx shadcn@latest init
# Select color scheme (neutral recommended)
# Components install to ./src/components/ui
```

**Detection:**

- Run `pnpm build` and check for import errors
- IDE shows red squiggles on `@/` imports
- Runtime: components fail to load with module resolution error

**Phase to address:** Phase 1 (setup)—must be correct before adding components.

---

### Pitfall 6: Tailwind v4 `@apply` Behavior Changes (If Using v4)

**What goes wrong:**

If you're using Tailwind CSS v4, `@apply` has subtle breaking changes from v3. Using `!important` with `@apply` requires different syntax. Custom CSS utilities that worked in v3 may not work in v4.

**Why it happens:**

Tailwind v4 changed how `@apply` processes directives:

```css
/* v3: Works fine */
.btn {
  @apply px-4 py-2 rounded !important;
}

/* v4: Requires different syntax */
.btn {
  @apply px-4 py-2 rounded;
  @apply !important; /* This is wrong in v4 */
}

/* v4 Correct syntax */
.btn {
  @apply [&]:px-4 [&]:py-2 [&]:rounded;
}
```

**Consequences:**

- Custom CSS components don't style correctly
- `!important` overrides don't apply
- Workarounds add complexity
- Requires rewriting custom CSS

**Prevention:**

1. **Pin Tailwind version in package.json:**

```json
{
  "dependencies": {
    "tailwindcss": "3.4.1"  // Use stable v3, not v4
  }
}
```

2. **If using v4, prefer Tailwind's new syntax:**

Instead of `@apply`, use Tailwind CSS layers:

```css
@import "tailwindcss";

@layer components {
  .btn {
    @apply px-4 py-2 rounded bg-blue-500 text-white;
  }

  .btn:hover {
    @apply bg-blue-600;
  }
}
```

3. **Avoid `!important` in `@apply`—use specificity instead:**

```css
/* Instead of: @apply px-4 !important; */
/* Use CSS layers for precedence: */

@layer components {
  .btn-primary {
    @apply px-4 py-2 rounded bg-blue-500;
  }
}

/* If override needed, use later layer: */
@layer utilities {
  .force-reset {
    @apply bg-gray-100 !important;
  }
}
```

**Detection:**

- Check `package.json` version
- `pnpm build` errors mentioning `@apply`
- Styles not applying when using `@apply` with complex modifiers

**Phase to address:** Phase 0 (stack decisions)—choose v3 for stability or commit to v4 migration if needed.

---

### Pitfall 7: Radix UI Unstyled Components Require Explicit Styling

**What goes wrong:**

You add Radix UI components (Dialog, Select already in your dependencies) expecting them to be styled. They're not—Radix ships unstyled by default. Components appear as plain, ugly, broken-looking elements until you add CSS.

**Why it happens:**

Radix UI philosophy: components handle accessibility and behavior, NOT appearance. You (or shadcn) must provide the CSS.

```tsx
// Your code
import { Dialog } from '@radix-ui/react-dialog';

<Dialog>
  <DialogTrigger>Open</DialogTrigger>
  <DialogContent>
    <p>Hello</p>
  </DialogContent>
</Dialog>

// Result: Plain, unstyled DOM elements
// Looks like a 1990s web page
```

**Consequences:**

- Components appear broken until styled
- No visual feedback for interactive states
- Accessibility features present but invisible
- Team thinks components are incomplete

**Prevention:**

1. **Use shadcn/ui versions of Radix components instead:**

shadcn wraps Radix with Tailwind CSS pre-styled.

```bash
pnpm dlx shadcn@latest add dialog
pnpm dlx shadcn@latest add select
```

Then import from shadcn, not Radix directly:

```tsx
// GOOD: shadcn wrapper with styling
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog';

<Dialog>
  <DialogTrigger>Open</DialogTrigger>
  <DialogContent>
    <p>Hello</p>
  </DialogContent>
</Dialog>
```

2. **If using Radix directly, add Tailwind CSS yourself:**

```tsx
import * as Dialog from '@radix-ui/react-dialog';

<Dialog.Root>
  <Dialog.Trigger className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600">
    Open
  </Dialog.Trigger>
  <Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 bg-black/50" />
    <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg shadow-lg p-6">
      <p>Hello</p>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
```

**Detection:**

- Components render but look unstyled
- No box-shadow, padding, or colors
- Hover/focus states not visible
- Compare with shadcn examples: if different, likely unstyled Radix

**Phase to address:** Phase 2-3 (component migration)—use shadcn versions of Radix components.

---

### Pitfall 8: CSS Module Naming Conflicts with Tailwind Class Names

**What goes wrong:**

If you keep CSS modules for complex styling and name classes the same as Tailwind utilities, confusion ensues. DevTools shows unclear which rule applies. Maintenance becomes a guessing game.

**Why it happens:**

```typescript
// TaskCard.module.css
.p4 { padding: 1rem; }      // Looks like Tailwind?
.flex { display: flex; }     // Looks like Tailwind?
.bg-white { background: white; } // Definitely looks like Tailwind

// TaskCard.tsx
import styles from './TaskCard.module.css';

<div className={`${styles.p4} flex`}>
  {/* Does this use CSS module .p4 or Tailwind .flex? Confusing! */}
</div>
```

**Consequences:**

- Confusion about which system applies styles
- Hard to debug: which `p4` is this?
- Other developers misunderstand codebase
- Refactoring introduces mistakes
- IDE autocomplete confuses scoped class with utility

**Prevention:**

1. **Name CSS module classes distinctly:**

```typescript
// TaskCard.module.css
.cardContainer { }      // Clear it's a module class
.cardHeader { }
.cardBody { }

// NOT .card (could be Tailwind future addition)
// NOT .p4 (looks like Tailwind)
```

2. **Document which system owns which elements:**

```tsx
// TaskCard.tsx
import styles from './TaskCard.module.css';

<div className={styles.cardContainer}>
  {/* ← CSS module scoped class */}

  <div className="p-4 bg-white shadow-md">
    {/* ← Tailwind utilities */}
  </div>
</div>
```

3. **Prefer component-scoped styling over generic names:**

```typescript
// GOOD: Component-specific names
.TaskCard__container { }
.TaskCard__header { }

// OR use BEM convention
.task-card { }
.task-card__header { }
.task-card__body { }
```

**Detection:**

- DevTools: multiple rules with similar names (scoped vs utility)
- IDE: autocomplete suggests CSS module class and Tailwind separately
- Confusion during code review: "Wait, is this Tailwind or CSS module?"

**Phase to address:** Phase 1 (setup)—establish naming convention before creating CSS modules.

---

## Minor Pitfalls

Mistakes that cause annoyance but are easily fixable.

### Pitfall 9: Missing Postcss Configuration for Tailwind Plugin

**What goes wrong:**

Tailwind v4 with Vite plugin requires proper Vite config but not always obvious. Build succeeds but Tailwind directives in CSS aren't processed.

**Why it happens:**

Simple oversight in vite.config.ts:

```typescript
// DANGER: Missing tailwindcss plugin
export default defineConfig({
  plugins: [react()],  // ← tailwindcss() missing
});
```

Result: Tailwind `@import` and `@layer` directives not processed.

**Prevention:**

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    tailwindcss(),  // ← Add this
    react(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
```

**Detection:**

- `@import "tailwindcss"` in CSS file doesn't generate utilities
- No Tailwind directives in built CSS
- Build warnings about unrecognized directives

---

### Pitfall 10: System Theme Detection Not Honoring Tauri System Preferences

**What goes wrong:**

You detect system theme preference on web (macOS: System Preferences > General > Appearance), but Tauri might not expose this API easily, or the detection runs at wrong time.

**Why it happens:**

Tauri doesn't provide built-in system theme detection API in v2. You must:
1. Use platform-specific code (Rust), OR
2. Use JavaScript `matchMedia`, which works but might be overridden by app settings

**Prevention:**

1. **Implement in Rust via Tauri sidecar:**

```rust
// src-tauri/src/main.rs
#[tauri::command]
fn get_system_theme() -> String {
    #[cfg(target_os = "macos")]
    {
        // Query macOS appearance
        "dark" // or "light" based on system settings
    }
    #[cfg(target_os = "windows")]
    {
        // Query Windows theme
        "light"
    }
    #[cfg(target_os = "linux")]
    {
        // Fallback to matchMedia
        "light"
    }
}
```

2. **Or use JavaScript API in frontend:**

```typescript
// App.tsx
useEffect(() => {
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  localStorage.theme = isDark ? 'dark' : 'light';
  document.documentElement.classList.toggle('dark', isDark);
}, []);
```

**Detection:**

- Change system theme, restart app
- If theme doesn't match OS preference, detection didn't work

---

## Phase-Specific Warnings

| Phase | Topic | Likely Pitfall | Mitigation |
|-------|-------|----------------|------------|
| 0 | Stack decision | Choose Tailwind v4 (new) vs v3 (stable) | Use v3.4.1 for stability; v4 requires new `@apply` syntax |
| 1 | Setup | Missing `@tailwindcss/vite` plugin | Add to vite.config.ts, verify with `pnpm build` |
| 1 | Setup | Content config doesn't find files | Verify glob patterns match actual file locations |
| 1 | Setup | Missing path aliases in tsconfig | Configure `baseUrl` and `paths` before shadcn init |
| 1 | Setup | Theme flashing on startup | Inject theme script in `<head>` before React loads |
| 2 | Components | Mixing old CSS with Tailwind | Migrate components completely, don't mix systems |
| 2 | Components | Dynamic class names | Audit all components, replace with static strings or CSS vars |
| 2 | Components | Using Radix directly instead of shadcn | Prefer shadcn wrappers; otherwise add Tailwind CSS manually |
| 3 | Integration | CSS conflicts from old system | Rename old CSS files to `.old`, verify no imports |
| 3 | Integration | Production build unstyled | Run `pnpm build && pnpm preview` locally; check built CSS |
| 4 | Testing | Theme toggle not persisting | Verify localStorage being set and read correctly |
| 4 | Testing | Responsive design broken | Check Tailwind breakpoints match design mockup |

---

## Summary: Migration Checklist

Before starting migration, verify:

- [ ] Tailwind v3.4.1 installed (or v4 with new syntax awareness)
- [ ] `@tailwindcss/vite` added to vite.config.ts
- [ ] `tsconfig.json` has `baseUrl` and `@` path alias configured
- [ ] `tailwind.config.ts` has correct `content` glob patterns
- [ ] Theme detection script in `index.html` `<head>` (before React)
- [ ] Old CSS files renamed/excluded from build
- [ ] shadcn/ui initialized with correct component paths
- [ ] No dynamic class name construction in components
- [ ] CSS modules renamed with non-Tailwind names
- [ ] `pnpm build` runs without errors
- [ ] `pnpm preview` shows correct styling (not just dev mode)

---

## Sources

- **Tailwind CSS Documentation** - Content configuration, dark mode, `@apply` in v4: https://tailwindcss.com/docs/
- **Vite CSS Guide** - CSS handling, modules, scoping: https://vite.dev/guide/features.html
- **shadcn/ui Docs** - Installation, path aliases, dark mode: https://ui.shadcn.com/docs/
- **Radix UI** - Component APIs, unstyled philosophy: https://radix-ui.com/primitives/
- **MDN CSS Cascade** - Specificity, cascade algorithm: https://developer.mozilla.org/en-US/docs/Web/CSS/Cascade
- **GSD Codebase** - Current CSS structure (10 files), Vite/Tauri setup, React 19

**Confidence:** HIGH for Tailwind/shadcn pitfalls (official docs), MEDIUM for Tauri-specific issues (requires testing).

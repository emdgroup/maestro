# v1.1 UI Redesign — Quick Reference Guide

**For:** Phase planning and implementation
**Updated:** 2026-02-09
**Status:** Ready for roadmap creation

---

## Installation One-Liner

```bash
npm install tailwindcss@^4.1.13 @tailwindcss/vite@^4.1.13 class-variance-authority@^0.7.1 clsx@^2.1.1 tailwind-merge@^2.5.5 tailwindcss-animate@^1.0.7 lucide-react@^0.563.0 zod@^3.24.1 @hookform/resolvers@^3.9.1 && npm install -D postcss@^8.5.0 autoprefixer@^10.4.20
```

---

## Critical Files to Create/Update

### 1. vite.config.ts (UPDATE)

Add ONE line before react() plugin:

```typescript
import tailwindcss from "@tailwindcss/vite"

export default defineConfig(async () => ({
  plugins: [
    tailwindcss(),  // <-- ADD THIS LINE (MUST BE BEFORE react())
    react(),
  ],
  // ... rest unchanged
}))
```

### 2. tailwind.config.ts (CREATE)

```typescript
import type { Config } from 'tailwindcss'

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        accent: { 50: '#f0f7ff', 500: '#0066cc', 600: '#0052a3' },
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
} satisfies Config
```

### 3. src/index.css (REPLACE ENTIRE FILE)

```css
@import "tailwindcss";

@theme {
  --color-accent-50: #f0f7ff;
  --color-accent-500: #0066cc;
  --color-accent-600: #0052a3;
}

@layer components {
  .btn-primary {
    @apply px-4 py-2 bg-accent-500 text-white rounded font-medium
           hover:bg-accent-600 transition-colors disabled:opacity-60;
  }
}
```

### 4. src/store/themeStore.ts (CREATE NEW)

```typescript
import { create } from 'zustand'

type Theme = 'light' | 'dark' | 'system'

interface ThemeStore {
  theme: Theme
  resolvedTheme: 'light' | 'dark'
  setTheme: (theme: Theme) => void
}

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(theme: Theme) {
  const html = document.documentElement
  const isDark = theme === 'dark' || (theme === 'system' && getSystemTheme() === 'dark')
  html.classList.toggle('dark', isDark)
  return isDark ? 'dark' : 'light'
}

export const useThemeStore = create<ThemeStore>((set) => {
  const savedTheme = (localStorage.getItem('app-theme') as Theme) || 'system'

  return {
    theme: savedTheme,
    resolvedTheme: applyTheme(savedTheme),
    setTheme: (theme: Theme) => {
      localStorage.setItem('app-theme', theme)
      const resolved = applyTheme(theme)
      set({ theme, resolvedTheme: resolved })
    },
  }
})

if (typeof window !== 'undefined') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const store = useThemeStore.getState()
    if (store.theme === 'system') {
      applyTheme('system')
    }
  })
}
```

### 5. src/components/ThemeProvider.tsx (CREATE NEW)

```typescript
import { useEffect } from 'react'
import { useThemeStore } from '@/store/themeStore'

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useThemeStore((state) => state.theme)

  useEffect(() => {
    const html = document.documentElement
    const isDark = theme === 'dark' ||
      (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    html.classList.toggle('dark', isDark)
  }, [theme])

  return <>{children}</>
}
```

### 6. src/App.tsx (UPDATE)

```typescript
import { ThemeProvider } from '@/components/ThemeProvider'

export function App() {
  return (
    <ThemeProvider>
      {/* Existing app content unchanged */}
    </ThemeProvider>
  )
}
```

---

## Color Mapping: Old CSS → Tailwind Classes

| Old CSS Variable | Tailwind Class | Dark Mode Class |
|-----------------|---|---|
| `--primary-color: #0066cc` | `accent-500` | `dark:accent-500` |
| `--accent-hover: #0052a3` | `accent-600` | `dark:accent-600` |
| `--bg-primary: #ffffff` | `bg-white` | `dark:bg-slate-900` |
| `--bg-secondary: #f5f5f5` | `bg-slate-50` | `dark:bg-slate-800` |
| `--text-primary: #000000` | `text-slate-900` | `dark:text-white` |
| `--text-secondary: #666666` | `text-slate-600` | `dark:text-slate-300` |
| `--border-color: #dddddd` | `border-slate-200` | `dark:border-slate-700` |
| `--hover-color: #eeeeee` | `hover:bg-slate-50` | `dark:hover:bg-slate-800` |

---

## Component Migration Pattern

### BEFORE (CSS)
```typescript
import './TaskCard.css'

export function TaskCard() {
  return <div className="task-card">Content</div>
}
```

### AFTER (Tailwind)
```typescript
import clsx from 'clsx'

export function TaskCard({ isDragging }: { isDragging?: boolean }) {
  return (
    <div className={clsx(
      'bg-white dark:bg-slate-900',
      'border border-slate-200 dark:border-slate-700',
      'rounded-md p-3 shadow-sm',
      'cursor-grab hover:shadow-md transition-shadow',
      isDragging && 'opacity-50'
    )}>
      Content
    </div>
  )
}
```

---

## Verification Checklist

- [ ] `npm install` completed without errors
- [ ] vite.config.ts has `tailwindcss()` BEFORE `react()` plugin
- [ ] tailwind.config.ts exists with content glob
- [ ] src/index.css replaced with `@import "tailwindcss"`
- [ ] vite dev server starts: `npm run tauri:dev`
- [ ] Page loads without CSS errors (check console)
- [ ] Dark mode CSS variables work: `html.classList.add('dark')`
- [ ] theme toggle button appears and switches theme
- [ ] System theme preference detected (change OS theme, refresh page)
- [ ] First component migrated and looks correct

---

## Key Decisions & Why

| Decision | Why | Alternative |
|----------|-----|-------------|
| Tailwind 4.x | Latest with @tailwindcss/vite plugin; zero-runtime | Tailwind 3.x (older, PostCSS setup) |
| Zustand theme store | Reuses existing dependency; simple implementation | next-themes (Next.js-only) |
| Custom theme provider | No new major dependencies; 50 lines of code | Headless UI theme system |
| Incremental migration | Per-component testing; lower risk | Big-bang rewrite (high risk) |
| CSS Modules for animations | Complex keyframes aren't Tailwind-friendly | All pure Tailwind (harder to read) |

---

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| "Cannot find tailwindcss" | npm install didn't complete | Run `npm install` again |
| "Dark mode not applying" | `tailwindcss()` plugin after `react()` | Reorder plugins in vite.config.ts |
| "HMR errors on startup" | Tailwind plugin compilation | Run `npm run tauri:dev` again |
| "Colors look wrong in dark mode" | @git-diff-view/react CSS conflict | Test specifically; may need CSS override |
| "Styles not hot-reloading" | Tailwind watcher needs restart | Ctrl+C, `npm run tauri:dev` again |
| "Bundle size too large" | Old CSS files not removed | Delete *.css files after migration |

---

## Performance Targets

| Metric | Target | Notes |
|--------|--------|-------|
| Dev build time | <3 seconds | Tailwind 4.x is fast |
| Hot reload latency | <100ms | CSS-only changes |
| Production bundle | <100KB JS + <100KB Tailwind CSS | After migration complete |

---

## Migration Order (Recommended)

1. **ProjectPicker** — 30 min (simple card styling)
2. **TaskCard** — 45 min (foundational Kanban piece)
3. **KanbanBoard** — 1 hour (layout + columns)
4. **TaskModal** — 1 hour (forms + inputs)
5. **AppHeader** — 30 min (navigation)
6. **Agent Monitor** — 1.5 hours (complex layout)
7. **Worktree Manager** — 1 hour (tables + lists)
8. **Settings Panel** — 1 hour (forms + tabs)

**Total estimate:** 7-8 hours implementation + testing

---

## Files NOT to Touch (Unchanged from v1.0)

- ❌ src-tauri/src/ (Rust backend)
- ❌ src-tauri/Cargo.toml (Rust deps)
- ❌ package.json (except npm install)
- ❌ tsconfig.json
- ❌ React component logic (only styling)
- ❌ Zustand store structure (only add theme slice)

---

## Important: Breaking Changes from v1.0 → v1.1

| Old Approach | New Approach | Impact |
|--------------|-------------|--------|
| CSS variables (`--primary-color`) | Tailwind classes (`accent-500`) | Must update all component classes |
| CSS Modules everywhere | Tailwind + selective CSS Modules | Simpler overall but requires migration |
| No dark mode support | Light/dark with system detection | Requires theme provider wrapper |
| Static theme (always light) | Dynamic theme toggle | User expectation change (positive) |

---

## Long-term Maintenance

**Keep in sync:**
- `tailwind.config.ts` — extends semantic colors
- `src/index.css` — `@theme` variables
- Component className strings — as features change

**No longer maintain:**
- Individual CSS files (except CSS Modules)
- Color variable definitions (moved to Tailwind)
- PostCSS config (replaced by @tailwindcss/vite)

---

## Success Criteria

✓ All components styled with Tailwind (or CSS Modules for animations)
✓ Light/dark theme works and persists on refresh
✓ System theme preference detected and applied
✓ No CSS regressions vs v1.0 visual design
✓ Bundle size <5% larger than v1.0 (justified by features)
✓ Dev server startup <3 seconds
✓ Production build passes all tests
✓ @git-diff-view/react renders correctly in both themes

---

*Quick reference for v1.1 UI Redesign implementation*
*Full details: UI_REDESIGN_STACK.md*

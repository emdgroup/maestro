# Phase 17: Polish & Testing - Research

**Researched:** 2026-02-10
**Domain:** Production build validation, accessibility testing (WCAG AA), CSS coverage verification, visual regression detection
**Confidence:** HIGH

## Summary

Phase 17 is a closure/validation phase with no new implementation—all feature work completed in Phases 13-16. Focus is validating production readiness through comprehensive testing across three dimensions: production build correctness (CSS purging, bundle validation), accessibility compliance (WCAG AA color contrast 4.5:1, focus rings, semantic HTML), and visual regression detection (comparing current rendering against v1.0 baseline to catch unintended visual breaks).

The standard approach for Tauri + React + Tailwind apps is:
1. **Build validation**: Verify production build succeeds, CSS is properly bundled (no purging issues), bundle verification script passes, dark mode persists without flicker
2. **Accessibility testing**: Manual contrast checking (WCAG AA 4.5:1 minimum for normal text), focus ring verification, semantic HTML audit, hover/disabled state validation
3. **Visual regression**: Screenshot baseline comparison using tools like Percy, Playwright visual assertions, or manual side-by-side comparison
4. **Responsive design**: Test at multiple viewport sizes (mobile, tablet, desktop) to catch layout regressions

No new libraries are required—we have the tooling in place (Tailwind 4.1, @tailwindcss/vite plugin, Tauri 2, Vite with bundle analysis script already implemented in Phase 13).

**Primary recommendation:** Use a phased testing approach—(1) Production build validation and CSS coverage verification with automated checks, then (2) Manual accessibility audit with WCAG AA checklist, then (3) Visual regression via screenshot comparison at key breakpoints and dark/light modes.

## Standard Stack

### Core Testing Approach
| Tool/Method | Version/Approach | Purpose | Why Standard |
|------------|------------------|---------|-------------|
| Production build via `pnpm tauri build` | Tauri 2.x | Full production binary compilation | Only way to validate final output; catches CSS bundling issues |
| Bundle verification script | Node.js, fs module | Validate mock code exclusion | Already implemented (Phase 13); prevents regression |
| Manual accessibility audit | WCAG AA checklist | Color contrast, focus rings, semantic HTML | Standardized compliance framework; no library dependency |
| Screenshot comparison | Manual or Playwright visual assertions | Visual regression detection | Catches unintended style changes without false positives |
| Responsive testing | Browser dev tools or Tauri window resize | Layout validation at multiple viewports | Essential for desktop app (users resize windows) |

### Supporting Tools & Patterns
| Tool | Purpose | When to Use |
|------|---------|-------------|
| Chrome DevTools Accessibility audit (Lighthouse) | Quick automated checks | Catching obvious issues (contrast, missing labels, semantic HTML) |
| Browser color contrast checker extension | Manual verification | Spot-checking specific elements against 4.5:1 ratio |
| Tauri window focus/blur testing | Dark mode persistence | Verify theme preference survives app restart |
| `import.meta.env.DEV` gate verification | Mock code exclusion | Ensure all dev-only code properly gated |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Manual WCAG AA audit | Automated axe-core or pa11y tools | Automated tools miss context-specific issues; manual audit catches edge cases |
| Manual screenshot comparison | Percy or visual regression CI | Manual is sufficient for v1.1 QA; CI tools overkill without continuous deployment |
| Manual responsive testing | Playwright screenshot suite | Manual is faster for one-time verification; Playwright overhead not justified yet |

## Architecture Patterns

### Phase 17 Verification Structure

Phase 17 splits into two focused plans:

**Plan 17-01: Production Build Validation & CSS Coverage**
- Focus: Verify `pnpm tauri build` succeeds without errors
- Validate no CSS purging issues (all component classes present in bundle)
- Run bundle verification script (catches mock code regression)
- Verify dark mode theme persistence across app restarts
- Verify system accent color properly applied
- Check responsive behavior at 1200x800, 1600x1000, 800x600 (edge cases)
- Validate no visual regressions from Phase 16 redesigns

**Plan 17-02: Accessibility Audit & QA Sign-Off**
- Focus: Manual WCAG AA compliance audit
- Check all text contrast ratios ≥ 4.5:1 (normal text)
- Verify focus rings visible on all interactive elements
- Validate semantic HTML (proper heading hierarchy, form labels, button roles)
- Check hover/focus/disabled states render correctly
- Verify dark mode contrast ≥ 4.5:1 (often fails with light colors on light backgrounds)
- Test keyboard navigation (Tab through all interactive elements)
- Verify smooth transitions and no flashing (accessibility criterion)

### Manual Accessibility Audit Workflow

**Step 1: Contrast Verification**
```
For each text element:
1. Identify foreground (text) and background colors from CSS variables
2. Calculate luminance: L = 0.2126 × R + 0.7152 × G + 0.0722 × B
3. Verify contrast ratio = (L_lighter + 0.05) / (L_darker + 0.05) ≥ 4.5:1
4. Test in both light AND dark modes (dark mode often has contrast issues)
```

**Step 2: Focus Ring Verification**
```
For each clickable element:
1. Tab to element
2. Verify focus ring visible (border or outline)
3. Verify focus ring has sufficient contrast against background
4. Verify focus ring is 2-3px (visible) not invisible or 1px
```

**Step 3: Interactive State Validation**
- Hover state: Shadow, border, or color change visible
- Disabled state: Opacity < 0.6 OR color change obvious
- Active/pressed state: Clear visual feedback (color change, elevation)
- No state should be invisible or ambiguous

### Dark Mode Persistence Testing

**Pattern: Dual Preload (Frontend + Tauri)**

Current implementation (Phase 14-03):
1. Tauri loads theme preference from AppSettings database before window shows
2. Frontend ThemeProvider detects system theme as fallback
3. Both apply `class="dark"` to `<html>` element
4. CSS variables switch via `html.dark { --color: ... }`

**Test procedure:**
1. Open app in dark mode
2. Toggle to light mode in Settings
3. Close and reopen app
4. Verify light mode persists (no flash of dark mode)
5. Close and toggle system theme
6. Reopen app
7. Verify system theme is respected (if auto mode)

### Bundle Validation Script Pattern

**Current implementation (Phase 13, `scripts/verify-bundle.mjs`):**
- Runs after `pnpm build`
- Scans dist/assets/*.js for mock markers
- Fails build if mock code found
- Prevents regression of tree-shaking optimization

**Should validate:**
1. Mock markers not in bundle (already implemented)
2. Tailwind classes not purged (new for Phase 17)

**CSS Coverage Verification Approach:**
Extract all component class names from source, verify each present in production CSS:
```javascript
// Pseudocode
const srcClasses = extractTailwindClasses(readFileSync('src'));
const bundleCSS = readFileSync('dist/assets/*.css');
for (const cls of srcClasses) {
  if (!bundleCSS.includes(cls)) {
    console.error(`Class ${cls} purged from bundle`);
  }
}
```

## Don't Hand-Roll

Problems that look simple but have existing solutions or hidden complexity:

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Accessibility audit | Custom contrast checker | Manual audit + Chrome DevTools Lighthouse | Chrome DevTools is authoritative, avoids miscalculation; WCAG AA math is complex (luminance, colorspace) |
| Visual regression | Custom pixel comparison | Manual screenshot comparison or Playwright visual assertions | Pixel-perfect comparison has massive false positive rate (sub-pixel rendering, font smoothing); manual is more reliable for one-time QA |
| Focus ring styling | Custom outline | Use `outline-ring` Tailwind class | Ensures consistent 2-3px width, proper contrast; custom outlines often too thin or invisible |
| Dark mode toggle | Custom localStorage | Use database + Tauri AppSettings (already implemented) | Persistent across app restarts; localStorage doesn't survive Tauri app reinstall |
| CSS purging detection | Manual review | Automated bundle verification script | Too error-prone to do manually; script is reliable |

**Key insight:** Testing and QA look "simple" (just click around) but have hidden complexity—contrast math is non-obvious, focus rings need specific sizing, color space matters (sRGB vs linear RGB), responsive issues appear only at specific viewport sizes. Use established approaches.

## Common Pitfalls

### Pitfall 1: Contrast Calculation Error

**What goes wrong:** Manual contrast verification uses wrong formula or colorspace.
- "This looks fine to me" → fails WCAG AA when measured
- Light gray text on white background looks acceptable but fails 4.5:1 requirement
- Using RGB directly instead of sRGB linearization gives wrong ratios

**Why it happens:**
- WCAG AA specifies sRGB color space with specific luminance formula
- Visual perception is non-linear (human eye perceives brightness logarithmically)
- Misunderstanding the formula leads to incorrect approval

**How to avoid:**
- Use WCAG AA calculator or Chrome DevTools contrast checker (built-in)
- Test both light and dark modes (dark backgrounds with light text often fail)
- Compare against reference: black on white = ~21:1, darkgray on white = ~6:1, lightgray on white = ~3:1 (FAILS)
- Flag any color pair with contrast < 5:1 for verification

**Warning signs:**
- Designer reports "looks fine" but contrast tools say it fails
- Light colors on light backgrounds (very common issue)
- Medium gray text in dark mode on dark gray background

### Pitfall 2: Dark Mode Flash on App Restart

**What goes wrong:**
- App loads with light mode, suddenly switches to dark mode
- Or vice versa—dark mode flashes then light mode applies
- User sees jarring mode switch on startup

**Why it happens:**
- Frontend loads HTML before Tauri preload script runs
- Race condition between CSS variable application and theme loading
- Missing `html.dark` class at page load time

**How to avoid:**
- Ensure Tauri preload applies theme BEFORE window renders (`beforeWindowCreated` hook)
- Use `html { color-scheme: dark; }` in CSS as fallback
- Verify Theme Provider detects system theme as secondary fallback
- Test with `setTimeout` artificial delay to simulate slow preload

**Warning signs:**
- Users report theme flashing on startup
- Theme in Settings matches current system theme (not persisted preference)
- App always starts in light mode regardless of Settings preference

### Pitfall 3: CSS Purging in Production Build

**What goes wrong:**
- Component classes disappear in production bundle
- Styling looks broken: Buttons have no color, layout collapses, etc.
- Works in dev (`pnpm dev`) but fails in production (`pnpm tauri build`)

**Why it happens:**
- Tailwind's content config specifies file patterns to scan
- Production build includes fewer files than dev (node_modules, build outputs)
- Dynamically generated class names not in source code (e.g., `bg-${color}` won't work)
- CSS variables with Tailwind (need explicit `<alpha-value>` syntax)

**How to avoid:**
- Verify `tailwind.config.ts` content array includes all source paths: `['./src/**/*.{ts,tsx}', './index.html']`
- Never use dynamic class names: `<div className={`bg-${color}`} />` ← WRONG
- Always use explicit class: `<div className="bg-success" />` ← RIGHT
- Use CSS variables correctly in Tailwind: `hsl(var(--color) / <alpha-value>)` not `hsl(var(--color))`
- Run bundle verification script after each build
- Test production build locally: `pnpm tauri build` + inspect dist/assets/

**Warning signs:**
- Components styled correctly in dev, unstyled in production
- Layout breaks in production build
- Bundle verification script passes but styling is wrong (CSS purging happened)

### Pitfall 4: Responsive Layout Breaks at Edge Sizes

**What goes wrong:**
- App looks good at 1200x800 (standard desktop), breaks at 800x600 (small screens)
- Or vice versa—small viewport works, large viewport breaks
- Kanban board columns overflow or collapse unexpectedly

**Why it happens:**
- Desktop app allows user resizing (unlike responsive web where breakpoints are predictable)
- Fixed widths or excessive padding cause overflow on small screens
- Large viewports have container width issues (cards too wide)
- CSS media queries not comprehensive enough

**How to avoid:**
- Test at multiple fixed sizes: 800x600 (small laptop), 1200x800 (standard), 1600x1000 (large desktop), 2560x1440 (ultrawide)
- Use relative sizing (flex, grid) not fixed widths
- Verify scrollbars don't cause layout shift
- Test with window resize (not just fixed breakpoints)
- Inspect container query support (Phase 15 includes `@tailwindcss/container-queries`)

**Warning signs:**
- Elements overflow without scrollbar
- Text truncated or wraps unexpectedly
- Hover tooltips appear off-screen on small viewports

### Pitfall 5: Keyboard Navigation Failure

**What goes wrong:**
- Tab key doesn't navigate to certain elements
- Enter/Space don't activate buttons or select items
- Focus gets trapped in a modal or section

**Why it happens:**
- Divs used as buttons without role="button" or `<button>` tag
- Tab index not managed (some elements focusable, others not)
- Modal doesn't trap focus (Tab key can escape to background)
- Accessibility not tested during development

**How to avoid:**
- Use semantic HTML: `<button>`, `<input>`, `<select>` instead of `<div role="button">`
- Verify shadcn/ui components used (already have proper ARIA and keyboard support)
- Test Tab key navigation: able to reach all interactive elements? Focus visible?
- Test Enter/Space: do buttons activate? Do selects open?
- Test Escape: does it close modals/popovers?
- Don't suppress focus rings for aesthetics (`outline: none` without replacement)

**Warning signs:**
- Screen readers can't navigate
- Tab key skips important elements
- Modal doesn't close with Escape
- Focus ring suppressed (`:focus { outline: none }` without `focus-visible`)

## Code Examples

### Contrast Calculation (WCAG AA)

```typescript
// Source: https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
function getRelativeLuminance(rgb: [r: number, g: number, b: number]): number {
  // Convert RGB (0-255) to sRGB (0-1)
  const [r, g, b] = rgb.map(val => {
    const v = val / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });

  // Weighted luminance (human eye perceives green brightest)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function getContrastRatio(rgb1: [number, number, number], rgb2: [number, number, number]): number {
  const l1 = getRelativeLuminance(rgb1);
  const l2 = getRelativeLuminance(rgb2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// Example: Dark gray text on white background
const darkGray = [68, 68, 68];      // #444444
const white = [255, 255, 255];
const ratio = getContrastRatio(darkGray, white);
console.log(`Contrast ratio: ${ratio.toFixed(2)}:1`); // ~8.6:1 (WCAG AAA compliant)

// Example: Light gray text on white (FAILS)
const lightGray = [192, 192, 192];  // #c0c0c0
const failRatio = getContrastRatio(lightGray, white);
console.log(`Contrast ratio: ${failRatio.toFixed(2)}:1`); // ~2.5:1 (FAILS WCAG AA)
```

### CSS Variable Usage in Tailwind (Correct Pattern)

```css
/* ✓ CORRECT: Tailwind recognizes <alpha-value> placeholder */
.colors {
  --primary: 0 0% 0%;
  --background: 215 13% 20%;
}

/* Usage in tailwind.config.ts */
colors: {
  primary: 'hsl(var(--primary) / <alpha-value>)',
  background: 'hsl(var(--background) / <alpha-value>)',
}

/* In React component */
<div className="bg-primary/50">  {/* Works: applies --primary with 50% alpha */}
  Text in primary color with 50% transparency
</div>

/* ✗ WRONG: Tailwind can't parse without <alpha-value> */
colors: {
  primary: 'hsl(var(--primary))',  // Missing <alpha-value>
}
// Result: Tailwind can't generate opacity variants (bg-primary/50 won't work)
```

### Dark Mode Persistence Pattern (Tauri Preload)

```typescript
// In Tauri main.rs or preload hook
fn setup_theme(app: &mut App) {
  // Load preference from database BEFORE window renders
  let state = app.state::<Arc<AppState>>();
  let conn = state.connection.lock().unwrap();
  let theme_pref = load_theme_preference(&conn); // "light", "dark", or "auto"

  // Get system theme if "auto"
  let theme = if theme_pref == "auto" {
    if prefers_dark_mode() { "dark" } else { "light" }
  } else {
    theme_pref
  };

  // Inject into HTML BEFORE rendering
  let preload_script = format!(
    r#"
      if ('{}' === 'dark') {{
        document.documentElement.classList.add('dark');
        document.documentElement.style.colorScheme = 'dark';
      }}
    "#,
    theme
  );

  // Apply via beforeWindowCreated hook or window.eval
  app.main_window()
    .eval(&preload_script)
    .expect("Failed to set theme");
}
```

### Bundle Verification with CSS Coverage Check

```javascript
// scripts/verify-bundle-enhanced.mjs
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const MOCK_MARKERS = [
  'mockDB',
  'Mock Tauri API',
];

const ESSENTIAL_CLASSES = [
  'grid-cols-5',      // Kanban board
  'gap-4',            // General spacing
  'bg-background',    // Core color
  'border-ring',      // Focus state
  'animate-pulse',    // Status dot animation
];

const BUNDLE_DIR = path.join(process.cwd(), 'dist/assets');

console.log('Verifying production bundle...');

// Check mock code
const jsFiles = fs.readdirSync(BUNDLE_DIR).filter(f => f.endsWith('.js'));
let failures = [];

for (const marker of MOCK_MARKERS) {
  for (const file of jsFiles) {
    const content = fs.readFileSync(path.join(BUNDLE_DIR, file), 'utf-8');
    if (content.includes(marker)) {
      failures.push(`Mock marker "${marker}" in ${file}`);
    }
  }
}

// Check CSS coverage
const cssFiles = fs.readdirSync(BUNDLE_DIR).filter(f => f.endsWith('.css'));
const bundleCSS = cssFiles
  .map(f => fs.readFileSync(path.join(BUNDLE_DIR, f), 'utf-8'))
  .join('\n');

for (const cls of ESSENTIAL_CLASSES) {
  if (!bundleCSS.includes(cls)) {
    failures.push(`Essential class "${cls}" missing from CSS bundle (purged?)`);
  }
}

if (failures.length > 0) {
  console.error('❌ Bundle verification FAILED:');
  failures.forEach(f => console.error(`  - ${f}`));
  process.exit(1);
}

console.log('✓ PASSED: Bundle verified');
process.exit(0);
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Manual CSS checking | Tailwind 4.1 + @tailwindcss/vite plugin | Phase 14 (2026-02-09) | Eliminated CSS build config overhead; plugin handles purging automatically |
| Custom theme system | CSS variables + ThemeProvider | Phase 14-03 (2026-02-09) | Dynamic theming without build step; system theme integration |
| Lighthouse CI/CD | Manual WCAG AA audit | v1.1 (in progress) | Simpler for v1.1 (no CI); comprehensive manual audit sufficient |
| Pixel-perfect visual regression | Manual screenshot comparison | v1.1 (in progress) | Sufficient for one-time v1.1 QA; overkill for non-continuous-deployment workflow |
| No focus ring styling | `outline-ring` Tailwind utility class | Phase 15 (2026-02-09) | Standardized focus state visible and accessible across all interactive elements |

**Deprecated/outdated:**
- Custom CSS grid media queries: Phase 16 uses Tailwind responsive utilities (sm:, md:, lg:) which are more maintainable
- Global CSS settings: Phase 15 migrated settings UI to shadcn/ui form controls with better accessibility
- Inline focus rings: Now use `focus:outline-ring focus:outline-2 focus:outline-offset-2` Tailwind utilities

## Open Questions

1. **What contrast ratio should we use for disabled states?**
   - WCAG AA requires 3:1 for UI components (buttons, borders, focus indicators) but normal text requires 4.5:1
   - Disabled buttons often have 60% opacity which may drop contrast below 3:1
   - **Recommendation:** Test actual disabled button contrast in both light and dark modes; if < 3:1, increase opacity or adjust button color

2. **Should we test responsive behavior at extreme sizes (2560x1440 ultrawide, 640x480 very small)?**
   - App targets desktop (1200+ width is standard), but users can resize
   - Testing 640x480 may be unnecessary if most users have 1024x768+
   - **Recommendation:** Test at 800x600 (minimum), 1200x800 (standard), 1600x1000 (large); anything smaller is edge case

3. **How thoroughly should we test dark mode color combinations?**
   - Dark mode has different contrast requirements (light text on dark backgrounds)
   - Some colors that pass light mode fail dark mode (e.g., yellow on white background = good, but light yellow on dark gray = poor)
   - **Recommendation:** Test all text colors in both light AND dark modes; flag any < 4.5:1

4. **Should Phase 17 include automated accessibility testing (pa11y, axe-core)?**
   - Automated tools catch obvious issues but miss context (e.g., unlabeled icon buttons that are semantically correct but fail axe)
   - Manual audit is more thorough but slower
   - **Recommendation:** Use Chrome DevTools Lighthouse for quick scan, then manual audit for edge cases; defer automated CI tools to v1.2 if continuous testing needed

5. **What is the acceptable margin for bundle size?**
   - Current: ~2.1 MB main bundle (638 KB gzipped)
   - Phase 13 reduced by 8kB with Tailwind 4.1 optimization
   - No regression should allow bundle to grow > 5% without investigation
   - **Recommendation:** Document baseline (638 KB gzipped), flag any production build > 670 KB gzipped for review

## Sources

### Primary (HIGH confidence)

- **CLAUDE.md** (local) — Project tech stack, build process, Phase 13-16 decisions
- **PROJECT.md** (local) — Project architecture, constraints, Phase 16 completion
- **16-VERIFICATION.md** (local) — Phase 16 deliverables validated, design system implemented
- **Phase 14-15 planning** (local) — Tailwind 4.1, shadcn/ui components, CSS variable setup confirmed
- **WCAG 2.1 AA Specification** (https://www.w3.org/TR/WCAG21/) — Authoritative contrast ratio formula and requirements
- **MDN Web Docs: Relative Luminance** (https://developer.mozilla.org/en-US/docs/Web/Accessibility/Understanding_WCAG/Perceivable/Color_contrast) — Luminance calculation and contrast verification

### Secondary (MEDIUM confidence)

- **Tailwind CSS Documentation** (https://tailwindcss.com) — CSS variable syntax, purging behavior, responsive utilities
- **Tauri 2 Documentation** (https://tauri.app) — App preload hooks, window configuration, theme persistence patterns
- **Chrome DevTools Accessibility Audit** — Built-in WCAG AA checker (verified in browser testing)

## Metadata

**Confidence breakdown:**
- **Standard stack:** HIGH — All tools already implemented (Tailwind 4.1, Vite, bundle verification, theme system)
- **Testing approaches:** HIGH — WCAG AA is standardized; manual audit is established practice
- **Architecture patterns:** HIGH — Dark mode persistence confirmed in Phase 14-03; CSS variable setup confirmed in Phase 15
- **Pitfalls:** MEDIUM — Based on Tauri + Tailwind + React best practices; some pitfalls may be project-specific

**Research date:** 2026-02-10
**Valid until:** 2026-03-10 (30 days for stable tech; WCAG AA and CSS are not changing in February-March)

**Note:** Phase 17 is unusual in that it's a validation/closure phase with no new architecture or libraries. All research focuses on verification procedures and edge cases, not novel technical challenges.

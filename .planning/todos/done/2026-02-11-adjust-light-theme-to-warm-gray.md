---
created: 2026-02-11T14:49
title: Adjust light theme to warm gray with orange/yellow hue
area: ui
files:
  - src/index.css
---

## Problem

The current light theme uses pure white (`#FFFFFF` or `hsl(0 0% 100%)`) for the background, which can cause several issues:

1. **Eye strain:** Pure white backgrounds can be harsh and cause eye fatigue, especially during extended use or in bright environments
2. **Lack of warmth:** Pure white feels sterile and cold, lacking the warmth of natural paper or ambient lighting
3. **High contrast:** Maximum brightness can be uncomfortable for some users
4. **Missing personality:** Pure white doesn't convey any brand character or aesthetic warmth

A warm, slightly tinted background (very light gray with orange/yellow hue) creates a more comfortable reading experience similar to cream-colored paper or warm ambient lighting. This is a common pattern in modern design systems that prioritize user comfort.

## Solution

Adjust the light theme CSS variables to use a warm gray background with subtle orange/yellow tones:

### 1. Color Selection

**Current (pure white):**
```css
--background: 0 0% 100%;  /* hsl(0, 0%, 100%) = #FFFFFF */
```

**Proposed (warm gray with orange/yellow hue):**
```css
/* Option 1: Subtle warmth (recommended) */
--background: 30 20% 98%;  /* Very light warm gray */

/* Option 2: More pronounced warmth */
--background: 35 25% 97%;  /* Slightly more saturated */

/* Option 3: Minimal warmth */
--background: 40 15% 99%;  /* Very subtle yellow-gray */
```

**Explanation of HSL values:**
- **Hue (30-40):** Orange/yellow range (30 = orange-yellow, 40 = more yellow)
- **Saturation (15-25%):** Low saturation for subtlety (not vibrant)
- **Lightness (97-99%):** Very light, close to white but not pure white

### 2. Related Variables to Adjust

To maintain proper contrast and visual hierarchy, adjust related variables:

```css
@media (prefers-color-scheme: light) {
  :root {
    /* Main background - warm gray */
    --background: 30 20% 98%;

    /* Card/elevated surfaces - slightly lighter or more saturated */
    --card: 30 20% 100%;  /* Or keep pure white for contrast */

    /* Muted backgrounds - slightly darker warm gray */
    --muted: 30 20% 95%;

    /* Borders - adjusted for new background */
    --border: 30 20% 90%;

    /* Keep text colors as-is for contrast */
    --foreground: 222 47% 11%;
  }
}
```

### 3. Design Considerations

**Contrast ratios:**
- Verify WCAG AA compliance (4.5:1 for normal text)
- Test with current foreground colors
- Ensure borders remain visible

**Visual testing:**
- Compare side-by-side with pure white
- Test with various content types (text, cards, modals)
- Verify in different lighting conditions
- Check that shadows/elevations still work

**Consistency:**
- Ensure card backgrounds work with new base
- Test modal overlays don't become too dark
- Verify input fields remain distinguishable

### 4. Implementation Steps

1. Update `src/index.css` light theme CSS variables
2. Test throughout application (Kanban board, Settings, modals)
3. Verify dark mode not affected
4. Check accessibility with contrast checker tools
5. Run Playwright visual regression tests if available
6. Gather user feedback on warmth level

### 5. Inspiration Examples

Modern apps with warm light themes:
- **Linear:** Uses subtle warm gray (#FAFAF9 / hsl(40 20% 98%))
- **Notion:** Cream-tinted background (#FFFFFF with slight warmth)
- **Obsidian:** Warm light mode with beige tones
- **Bear Notes:** Cream/sepia tones for comfortable reading

**Recommended starting point:** `hsl(30 20% 98%)` - subtle orange warmth, very light, comfortable for extended use.

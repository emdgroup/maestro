# Plan: Add Terminal Color Mode Setting

## Context

Terminal currently always follows app theme (bg/fg from CSS vars). User wants option to use default xterm colors (black bg, white text) instead. This is a global setting (not per-project).

## Changes

### 1. Rust Model — `src-tauri/src/models/settings.rs`

Add `TerminalColorMode` enum (same pattern as `ActivityVisibility`):

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
#[specta(export)]
pub enum TerminalColorMode {
    #[default]
    FollowTheme,
    Default,
}
```

With `Display` + `FromStr` impls (`"follow_theme"` / `"default"`).

Add field to `AppSettings`:
```rust
#[serde(default)]
pub terminal_color_mode: TerminalColorMode,
```

### 2. DB Layer — `src-tauri/src/db/settings.rs`

- `load_settings()`: parse `terminal_color_mode` from map with `unwrap_or_default()`
- `save_settings()`: serialize to string, add to pairs vec

### 3. Regenerate Bindings

`pnpm tauri:gen` — produces `TerminalColorMode` type in `src/types/bindings.ts`

### 4. Terminal Theme Helper — `src/utils/helpers/terminalTheme.ts`

Add optional `colorMode` param. When `"default"`, return only font config (no `theme` property → xterm uses built-in black/white). When `"follow_theme"` or omitted, current CSS-var behavior.

### 5. Terminal Component — `src/components/execution/Terminal.tsx`

- Import `useSettings` from settings service
- Read `terminal_color_mode` from settings
- Pass to `getTerminalTheme(colorMode)`
- Add `terminalColorMode` to useEffect deps (terminal remounts on change — acceptable for infrequent setting change)

### 6. Settings UI — `src/components/common/SettingsPage.tsx`

Add "Appearance" card between "Agent & Model" and "Issue Tracking" cards. Contains a `<Select>` with two options:
- "Follow app theme" (`follow_theme`)
- "Default (black background)" (`default`)

Uses `useSettings()` / `useSaveSettings()` for immediate mutation (same pattern as AgentsView visibility settings — independent of project form submit).

## File List

| File | Action |
|------|--------|
| `src-tauri/src/models/settings.rs` | Add enum + field |
| `src-tauri/src/db/settings.rs` | Load/save new field |
| `src/utils/helpers/terminalTheme.ts` | Accept mode param |
| `src/components/execution/Terminal.tsx` | Wire setting to theme |
| `src/components/common/SettingsPage.tsx` | Add Appearance card |
| `src/types/bindings.ts` | Auto-regenerated |

## Verification

1. `cargo build` — Rust compiles with new field
2. `pnpm tauri:gen` — bindings regenerate
3. `pnpm build` — frontend compiles
4. Run app → Settings tab → "Appearance" card visible with dropdown
5. Switch to "Default" → open terminal → black background, white text
6. Switch to "Follow app theme" → terminal matches app bg/fg
7. Existing terminals remount with new colors on setting change

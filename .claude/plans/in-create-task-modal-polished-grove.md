# Plan: Fix CreateTaskModal sizing

## Context

When importing issues with long titles, the CreateTaskModal is too narrow (520px max). Long titles get truncated with no room to read them. Conversely, pasting long descriptions causes the dialog to grow indefinitely in height with no cap.

## Changes

**File:** `src/components/kanban/CreateTaskModal.tsx`

### 1. Increase max width (line 220)

```diff
- <DialogContent className="sm:max-w-[520px] overflow-y-auto custom-scrollbar">
+ <DialogContent className="sm:max-w-[1200px] overflow-y-auto custom-scrollbar">
```

### 2. Cap textarea height with internal scroll (lines 326-334)

```diff
  <Textarea
    {...register("description", { ... })}
    placeholder="Add description..."
-   rows={3}
-   className="border-0 shadow-none bg-transparent dark:bg-transparent px-0 resize-none focus-visible:ring-0 placeholder:text-muted-foreground/50"
+   className="border-0 shadow-none bg-transparent dark:bg-transparent px-0 resize-none focus-visible:ring-0 placeholder:text-muted-foreground/50 min-h-[4.5rem] max-h-[300px] overflow-y-auto"
  />
```

- Remove `rows={3}` — base Textarea has `field-sizing-content` which auto-grows with content
- `min-h-[4.5rem]` — equivalent to ~3 rows minimum
- `max-h-[300px]` — caps growth, then internal scrollbar takes over
- `overflow-y-auto` — shows scrollbar only when content exceeds max-h

No max-h on DialogContent itself — textarea cap prevents unbounded dialog growth. Dialog's existing `overflow-y-auto` remains as viewport-edge safety net.

## Verification

1. `pnpm dev` — open Create Task modal
2. Import an issue with long title → dialog should be wider, title visible
3. Paste multi-paragraph description → textarea grows to ~300px then scrolls internally
4. Dialog itself should not exceed viewport height

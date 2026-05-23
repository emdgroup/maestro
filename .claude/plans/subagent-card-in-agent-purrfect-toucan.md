# Fix SubagentCard: duplicate prompt, expand state, output height

## Context

SubagentCard in agent activity panel has three UX bugs:
1. Prompt text appears twice — once in collapsible "Prompt" section, again in output
2. Prompt section stays collapsed when subagent is streaming with no output yet
3. Output section has small fixed max-height with scrollbar instead of growing to fit

All changes in one file: `src/components/execution/activity/SubagentCard.tsx`

---

## Fix 1: Prompt displayed twice (lines 138-165)

**Root cause**: `displayText` deduplication does `text.startsWith(prompt)` which fails on whitespace differences. Also, the prompt sometimes appears as a separate content block that gets joined into `rawText`.

**Fix**: Two-layer dedup:

1. Move `prompt` extraction (line 158) **before** `rawText` memo (line 138)
2. In `rawText` memo, skip first content block if it matches prompt (trimmed comparison)
3. Keep existing `displayText` startsWith check as fallback

```ts
// Move prompt before rawText
const prompt = typeof item.rawInput?.prompt === "string" ? item.rawInput.prompt : null;

const rawText = useMemo(() => {
  const textBlocks = item.content
    .filter(...)
    .map((c) => c.content.text);
  // Skip first block if it's the echoed prompt
  if (prompt && textBlocks.length > 0 && textBlocks[0].trim() === prompt.trim()) {
    return textBlocks.slice(1).join("");
  }
  return textBlocks.join("");
}, [item.content, prompt]);
```

## Fix 2: Prompt expanded when no output yet (lines 175-179)

**Root cause**: Effect has `!isStreaming` guard, so prompt stays collapsed during streaming even with no output.

**Fix**: Remove `!isStreaming` guard. Open prompt whenever card expanded and no displayText.

```ts
useEffect(() => {
  if (expanded && !displayText) {
    setPromptOpen(true);
  }
}, [expanded, displayText]);
```

## Fix 3: Output full height, no cap, no scrollbar (line 281)

**Root cause**: `max-h-72` (288px) + `overflow-y-auto` = constrained scrollable box.

**Fix**: Remove max-height and overflow entirely. Content displays at natural height.

```
- max-h-72 overflow-y-auto custom-scrollbar
+ (removed — no height constraint, no overflow)
```

Auto-scroll effect (lines 181-185) + `outputRef` become dead code — remove both.

---

## Verification

1. `pnpm lint` — no lint errors
2. `pnpm test SubagentCard` — if tests exist
3. Manual: open Maestro, run agent with subagent, verify:
   - Prompt shows only in "Prompt" section, not duplicated in output
   - Prompt section auto-opens when subagent starts (no output yet)
   - Output grows to fit content, no scrollbar, clips at ~32rem

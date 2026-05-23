# Fix User Message Markdown Rendering Issues

## Context

User messages in the agent activity panel are rendered through the same `MarkdownBlock` component as agent messages. This causes two UX issues:

1. **Numbered list hijacking**: User types "2." as a reply → markdown parser interprets as ordered list → renders as "1." (CommonMark always renumbers ordered lists from the first item's number, or the `ol` component ignores `start` attr)
2. **Missing line breaks**: User presses Enter for a line break → markdown treats single `\n` as soft wrap (rendered as space) → text appears run together unless user double-enters

Root cause: user messages are conversational text, not authored markdown. They shouldn't get full markdown parsing for structural elements like lists.

## Approach: Pre-process user text before MarkdownBlock

Add a `preprocessUserMarkdown()` function that transforms user text to render correctly as markdown while preserving user intent:

1. **Escape ordered list patterns**: Only when a non-1 number+dot appears at the very start of the message (position 0). "1." renders correctly anyway; only "2.", "3." etc. get mangled to "1." by markdown list renumbering.
2. **Preserve line breaks**: Replace every `\n` with `\n ` (append space after newline)

This avoids creating a separate component or adding plugins — just string preprocessing before passing to existing `MarkdownBlock`.

## Files to Modify

- `src/components/execution/activity/ActivityUserMessage.tsx` — add `preprocessUserMarkdown()` and apply it before `MarkdownBlock`

## Implementation

```typescript
function preprocessUserMarkdown(text: string): string {
  return text
    // Escape non-1 numbered list at message start (e.g., "2." → "2\.")
    // Only position 0 — "1." renders fine, only 2+ gets mangled to "1."
    .replace(/^([2-9]\d*|[1-9]\d+)\./, "$1\\.")
    // Preserve single line breaks (newline + space)
    .replace(/\n/g, "\n ");
}
```

Apply in `ActivityUserMessage`:
```tsx
// Line 91-93 change from:
<MarkdownBlock text={buildTextMarkdown(parsed.blocks)} />
// and:
<MarkdownBlock text={parsed.text} />

// To:
<MarkdownBlock text={preprocessUserMarkdown(buildTextMarkdown(parsed.blocks))} />
// and:
<MarkdownBlock text={preprocessUserMarkdown(parsed.text)} />
```

## Edge Cases

- **Double newlines**: The regex `(?<!\n)\n(?!\n)` only matches single newlines, leaving `\n\n` (paragraph breaks) untouched — those already render as expected
- **User intentionally writes a list**: Unlikely in chat context, and they can still use `- ` for unordered lists. Acceptable tradeoff.
- **Code blocks**: Preprocessing runs on raw text before markdown parsing, so fenced code blocks could be affected. Should skip content inside triple backticks.

### Refined implementation handling code blocks:

```typescript
function preprocessUserMarkdown(text: string): string {
  // Split on fenced code blocks, only process non-code segments
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part, i) => {
      // Odd indices are code blocks — leave untouched
      if (i % 2 === 1) return part;
      return part
        // Only escape non-1 number+dot at very start of the segment
        .replace(/^([2-9]\d*|[1-9]\d+)\./, "$1\\.")
        .replace(/\n/g, "\n ");
    })
    .join("");
}
```

## Verification

1. Run `pnpm dev` / `pnpm tauri:dev`
2. Open an agent session, send message "2." — should display "2." not "1."
3. Send message with single line returns — should display with line breaks
4. Send message with code block containing "1." — should not be escaped
5. Send message with double newline — should create paragraph gap (existing behavior preserved)
6. Run `pnpm test` to confirm no regressions

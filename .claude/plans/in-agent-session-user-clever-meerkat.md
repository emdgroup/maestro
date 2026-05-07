# Plan: Render user messages with markdown in agent session

## Context

User messages in the agent activity panel render as plain text (`whitespace-pre-wrap` spans). Assistant messages use `MarkdownBlock` (react-markdown with GFM, syntax highlighting, etc). User wants parity — user messages should also render through the markdown renderer.

## Change

**File**: `src/components/execution/activity/ActivityUserMessage.tsx`

Replace plain `<span>{block.text}</span>` rendering with `<MarkdownBlock text={block.text} />` for text blocks.

### Details

1. Import `MarkdownBlock` from `./MarkdownBlock`
2. Replace the text block rendering (line 57: `<span key={i}>{block.text}</span>`) with `<MarkdownBlock key={i} text={block.text} />`
3. Remove `whitespace-pre-wrap` from the container div since MarkdownBlock handles its own spacing
4. Keep the card/border styling to visually distinguish user messages from assistant messages
5. Keep attachment badge rendering unchanged

### Styling consideration

The container currently has `whitespace-pre-wrap` which conflicts with markdown block-level elements. Remove it, but keep `break-words` for long URLs. The `text-sm leading-relaxed` stays — MarkdownBlock inherits font size from parent.

## Verification

1. `pnpm dev` — open agent session
2. Send a message with markdown (bold, code, list, link)
3. Confirm it renders with formatting, not as raw text
4. Confirm plain text messages still look normal
5. Confirm attachment badges still render correctly

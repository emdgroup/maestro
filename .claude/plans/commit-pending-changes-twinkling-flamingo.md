# Commit pending changes

## Context

Working tree has two coherent themes of changes ready to commit:
1. **ACP elicitation protocol support** — adds `agent-client-protocol-schema` dependency, validates elicitation requests/responses against schema types, advertises elicitation capabilities, and extracts `message` field to send to frontend separately from payload
2. **Context popover UX** — hover-intent behavior (delay close + popover stays open on mouse enter), PopoverArrow component, collisionPadding prop, always render token data (remove size > 1 guards)

Plus cleanup: staged deletions of HTML mockup files.

## Plan

Single commit (changes are interrelated — elicitation message field flows end-to-end from server through protocol to UI).

### Commit message

```
Add elicitation schema validation and improve context popover UX

Wire agent-client-protocol-schema to validate elicitation requests and
responses. Extract message field from ACP elicitation request and pass it
through the protocol to the frontend, simplifying parseElicitationFields.
Advertise elicitation capabilities during ACP session negotiation.

Improve LiquidContextIndicator popover: add hover-intent delay, arrow,
collision padding, and always render token usage data.
```

### Files to stage

All modified + deleted + skip untracked `.claude/plans/` files:
- `Cargo.lock`
- `maestro-protocol/src/lib.rs`
- `maestro-server/Cargo.toml`
- `maestro-server/src/session_handler.rs`
- `src/components/execution/AgentActivityPanel.tsx`
- `src/components/execution/activity/ElicitationPrompt.tsx`
- `src/components/execution/activity/LiquidContextIndicator.tsx`
- `src/components/execution/activity/useAcpSessionLifecycle.ts`
- `src/components/execution/activity/utils.ts`
- `src/components/ui/popover.tsx`
- `.claude/plans/context-popover-preview.html` (delete)
- `composer-facelift-mockup.html` (delete)
- `.claude/plans/i-want-a-redesign-fizzy-nebula.md` (modified plan file)

### Verification

`git log --oneline -1` confirms commit created. No tests to run for this commit (protocol field addition + UI tweaks).

# Fix EffortSelector not rendering after category change

## Context

The ACP agent (Claude CLI) changed its config option for effort from `category: "effort"` to `category: "thought_level"`. The `id` remains `"effort"` and the `options` array structure is unchanged. Because `ConfigSelector.tsx` switches on `option.category`, the `"thought_level"` value now falls through to `GenericSelector` instead of `EffortSelector`.

## Change

**File:** `src/components/execution/activity/config-selectors/ConfigSelector.tsx`

Add `"thought_level"` case to the switch statement, routing to `EffortSelector`. Keep old `"effort"` case for backward compatibility with older agent versions.

```tsx
case "effort":
case "thought_level":
  return (
    <EffortSelector option={option} value={value} onChange={onChange} disabled={disabled} />
  );
```

That's it — single file, 1-line addition.

## Verification

1. `pnpm build` — type check passes
2. Start agent session, observe effort bars render (not generic dropdown)
3. Confirm clicking bars still sends correct value via `set_acp_config_option`

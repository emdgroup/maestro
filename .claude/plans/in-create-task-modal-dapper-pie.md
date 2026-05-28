# Plan: Replace search icon + "Connected to" label with provider-branded search bar

## Context

In the Create Task modal, when an issue tracking provider is configured, a search bar appears with a generic magnifying glass icon and "Search issues..." placeholder. Below it sits a "Connected to <provider>" label. The user wants to remove this label and instead communicate the provider context *within* the search bar itself — using the provider's brand icon and a contextual placeholder like "Search owner/repo issues".

## File to modify

`src/components/kanban/CreateTaskModal.tsx`

## Changes

### 1. Add import for BrandIcon

```tsx
import { BrandIcon } from "@/components/common/BrandIcon";
```

Also import `ProjectIssueTrackingConfig` type for the helper function.

### 2. Add helper function (before component, after imports)

```tsx
function getIssueSearchPlaceholder(config: ProjectIssueTrackingConfig): string {
  const { provider, owner, repo, project_path, project_key, team_id, project_name } = config;
  let context: string;
  switch (provider) {
    case "github":
    case "forgejo":
    case "gitea":
      context = owner && repo ? `${owner}/${repo}` : "";
      break;
    case "gitlab":
      context = project_path ?? "";
      break;
    case "jira_cloud":
      context = project_key ?? "";
      break;
    case "linear":
      context = team_id ?? "";
      break;
    case "azuredevops":
      context = project_name ?? "";
      break;
    default:
      context = "";
  }
  return context ? `Search ${context} issues` : "Search issues...";
}
```

### 3. In PopoverTrigger — replace Search icon with BrandIcon

```tsx
<BrandIcon slug={issueConfig.provider} className="shrink-0 text-muted-foreground" width={14} height={14} />
```

### 4. Update placeholder text in trigger + CommandInput

Both use `getIssueSearchPlaceholder(issueConfig)` instead of hardcoded "Search issues..."

### 5. Remove "Connected to" label + wrapping div

Remove the `<div className="flex flex-col gap-1.5">` wrapper and the `<span>` label. Popover sits directly inside the `{hasProvider && (...)}` block.

## Verification

1. `pnpm build` — type check passes
2. `pnpm dev` — open Create Task modal with a configured provider, confirm:
   - Provider icon shows instead of magnifying glass
   - Placeholder reads "Search owner/repo issues" (or equivalent)
   - No "Connected to" label below
   - Dropdown CommandInput has same contextual placeholder
3. Test with no issue config — search bar hidden entirely (unchanged behavior)

# Plan: Replace Monochrome Brand Icons with Colored `@thesvg/react` Components

## Context

Brand icons throughout the app are monochrome. Integration providers use `simple-icons` (single-path, `fill="currentColor"`). Agent icons load from ACP CDN as monochrome SVGs with `dark:[filter:invert(1)]`. User wants full-color brand icons using `@thesvg/react` (3,800+ colored brand SVG components with tree-shaking).

## Scope

Replace both icon systems:
1. Integration provider icons in Project Picker
2. AI agent icons in execution/session views

## Icon Mapping

### Integration Providers

| Provider key | `@thesvg/react` import |
|---|---|
| `github` | `Github` from `@thesvg/react/github` |
| `gitlab` | `Gitlab` from `@thesvg/react/gitlab` |
| `jira_cloud` | `Jira` from `@thesvg/react/jira` |
| `bitbucket` | `Bitbucket` from `@thesvg/react/bitbucket` |
| `linear` | `Linear` from `@thesvg/react/linear` |
| `forgejo` | `Forgejo` from `@thesvg/react/forgejo` |
| `gitea` | `Gitea` from `@thesvg/react/gitea` |
| `azuredevops` | `AzureAzureDevops` from `@thesvg/react/azure-azure-devops` |

### AI Agents

| Agent ID | `@thesvg/react` import |
|---|---|
| `amp-acp` | `Amp` from `@thesvg/react/amp` |
| `claude-acp` | `ClaudeCode` from `@thesvg/react/claude-code` |
| `cline` | `Cline` from `@thesvg/react/cline` |
| `codex-acp` | `CodexOpenai` from `@thesvg/react/codex-openai` |
| `cursor` | `Cursor` from `@thesvg/react/cursor` |
| `gemini` | `GoogleGemini` from `@thesvg/react/google-gemini` |
| `github-copilot-cli` | `GithubCopilot` from `@thesvg/react/github-copilot` |
| `goose` | `GooseCodename` from `@thesvg/react/goose-codename` |
| `junie` | `Junie` from `@thesvg/react/junie` |
| `kilo` | `KiloCode` from `@thesvg/react/kilo-code` |
| `kimi` | `Kimi` from `@thesvg/react/kimi` |
| `mistral-vibe` | `MistralAi` from `@thesvg/react/mistral-ai` |
| `opencode` | `Opencode` from `@thesvg/react/opencode` |
| `qwen-code` | `Qwen` from `@thesvg/react/qwen` |
| `auggie` | (no match — fallback) |
| `autohand` | (no match — fallback) |
| `codebuddy-code` | (no match — fallback) |
| `corust-agent` | (no match — fallback) |
| `crow-cli` | (no match — fallback) |
| `deepagents` | (no match — fallback) |
| `factory-droid` | (no match — fallback) |
| `fast-agent` | (no match — fallback) |
| `minion-code` | (no match — fallback) |
| `nova` | (no match — fallback) |
| `pi-acp` | (no match — fallback) |
| `qoder` | (no match — fallback) |
| `stakpak` | (no match — fallback) |

Agents without thesvg coverage keep existing CDN icon behavior (`<img>` with fallback to first letter).

## Implementation

### Step 1: Install package

```bash
pnpm add @thesvg/react
```

### Step 2: Create shared `BrandIcon` component

**New file: `src/components/common/BrandIcon.tsx`**

Central component that maps a brand slug to its `@thesvg/react` component. Used by both provider icons and agent icons.

```tsx
import { type ComponentType, type SVGProps, lazy, Suspense } from "react";

// Provider icons (statically imported for providers — always needed)
import { Github } from "@thesvg/react/github";
import { Gitlab } from "@thesvg/react/gitlab";
import { Jira } from "@thesvg/react/jira";
import { Bitbucket } from "@thesvg/react/bitbucket";
import { Linear } from "@thesvg/react/linear";
import { Forgejo } from "@thesvg/react/forgejo";
import { Gitea } from "@thesvg/react/gitea";
import { AzureAzureDevops } from "@thesvg/react/azure-azure-devops";

// Agent icons
import { Amp } from "@thesvg/react/amp";
import { ClaudeCode } from "@thesvg/react/claude-code";
import { Qwen } from "@thesvg/react/qwen";
import { Cline } from "@thesvg/react/cline";
import { CodexOpenai } from "@thesvg/react/codex-openai";
import { Cursor } from "@thesvg/react/cursor";
import { GoogleGemini } from "@thesvg/react/google-gemini";
import { GithubCopilot } from "@thesvg/react/github-copilot";
import { GooseCodename } from "@thesvg/react/goose-codename";
import { Junie } from "@thesvg/react/junie";
import { KiloCode } from "@thesvg/react/kilo-code";
import { Kimi } from "@thesvg/react/kimi";
import { MistralAi } from "@thesvg/react/mistral-ai";
import { Opencode } from "@thesvg/react/opencode";

type SvgIcon = ComponentType<SVGProps<SVGSVGElement>>;

const BRAND_ICONS: Record<string, SvgIcon> = {
  // Providers
  github: Github,
  gitlab: Gitlab,
  jira_cloud: Jira,
  bitbucket: Bitbucket,
  linear: Linear,
  forgejo: Forgejo,
  gitea: Gitea,
  azuredevops: AzureAzureDevops,
  // Agents
  "amp-acp": Amp,
  "claude-acp": ClaudeCode,
  "qwen-code": Qwen,
  cline: Cline,
  "codex-acp": CodexOpenai,
  cursor: Cursor,
  gemini: GoogleGemini,
  "github-copilot-cli": GithubCopilot,
  goose: GooseCodename,
  junie: Junie,
  kilo: KiloCode,
  kimi: Kimi,
  "mistral-vibe": MistralAi,
  opencode: Opencode,
};

interface BrandIconProps {
  slug: string;
  className?: string;
  width?: number;
  height?: number;
}

export function BrandIcon({ slug, className, width = 16, height = 16 }: BrandIconProps) {
  const Icon = BRAND_ICONS[slug];
  if (!Icon) return null;
  return <Icon className={className} width={width} height={height} />;
}

export function hasBrandIcon(slug: string): boolean {
  return slug in BRAND_ICONS;
}
```

### Step 3: Replace `ProviderIcon` in IntegrationsTab

**File: `src/components/project-picker/IntegrationsTab.tsx`**

- Remove `simple-icons` imports
- Import `BrandIcon` from `@/components/common/BrandIcon`
- Replace `ProviderIcon` component to delegate to `BrandIcon`
- Remove `PROVIDER_SIMPLE_ICONS` map
- Keep `CapabilityTag`'s git icon (minor, can use a generic git icon or keep simple-icons for just that one)

### Step 4: Replace agent `<img>` icons with `BrandIcon`

**Files to modify:**
- `src/components/execution/AgentMonitor.tsx` (lines 87-96, 144-148, 338-342)
- `src/components/execution/SpawnSessionDialog.tsx` (lines 205-211)
- `src/components/execution/SessionHistoryPanel.tsx` (lines 248-253)
- `src/components/common/SettingsPage.tsx` (lines 197-204)
- `src/views/AgentsView.tsx` (lines 95-97 — `agentIcons` map becomes unnecessary)

Pattern change:
```tsx
// Before
{agent.icon ? (
  <img src={agent.icon} className="w-4 h-4 rounded-sm dark:[filter:invert(1)]" onError={...} />
) : (
  <span className="text-[10px] font-bold text-muted-foreground">{agent.name[0]}</span>
)}

// After
{hasBrandIcon(agent.id) ? (
  <BrandIcon slug={agent.id} className="w-4 h-4" />
) : agent.icon ? (
  <img src={agent.icon} className="w-4 h-4 rounded-sm dark:[filter:invert(1)]" onError={...} />
) : (
  <span className="text-[10px] font-bold text-muted-foreground">{agent.name[0]}</span>
)}
```

This gives 3-tier fallback: thesvg colored → CDN monochrome → first letter.

### Step 5: Remove `simple-icons` dependency

```bash
pnpm remove simple-icons
```

Only if `CapabilityTag`'s git icon is also replaced (e.g., with a generic `<Git>` icon or lucide's `GitBranch`).

### Step 6: Dark mode

Colored SVGs from thesvg are multi-color and work on both backgrounds. No `filter:invert(1)` needed. Exception: GitHub's icon might be dark — verify visually and add `dark:bg-white/10` rounded container if needed.

## Files Modified

| File | Change |
|---|---|
| `package.json` | Add `@thesvg/react`, potentially remove `simple-icons` |
| `src/components/common/BrandIcon.tsx` | **NEW** — central brand icon registry |
| `src/components/project-picker/IntegrationsTab.tsx` | Replace `ProviderIcon` + remove simple-icons |
| `src/components/execution/AgentMonitor.tsx` | Use `BrandIcon` for agent icons |
| `src/components/execution/SpawnSessionDialog.tsx` | Use `BrandIcon` for agent icons |
| `src/components/execution/SessionHistoryPanel.tsx` | Use `BrandIcon` for agent icons |
| `src/components/common/SettingsPage.tsx` | Use `BrandIcon` for agent icons |
| `src/views/AgentsView.tsx` | Simplify `agentIcons` map (optional) |

## Verification

1. `pnpm dev` → Project Picker → Integrations tab: all 8 provider icons render in color
2. Agents view → Spawn dialog: agents with thesvg coverage show colored icons
3. Agent monitor sessions list: colored icons for known agents, CDN fallback for others
4. Toggle dark/light mode: icons remain visible and colored (no invert artifacts)
5. `pnpm build` — no TS errors, tree-shaking works (only imported icons bundled)
6. `pnpm test` — existing tests pass

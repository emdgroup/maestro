import type { ForwardRefExoticComponent, RefAttributes, SVGProps } from "react";
import { cn } from "@/lib/utils.ts";
import Github from "@thesvg/react/github";
import Gitlab from "@thesvg/react/gitlab";
import Jira from "@thesvg/react/jira";
import Bitbucket from "@thesvg/react/bitbucket";
import Linear from "@thesvg/react/linear";
import Forgejo from "@thesvg/react/forgejo";
import Gitea from "@thesvg/react/gitea";
import AzureAzureDevops from "@thesvg/react/azure-azure-devops";
import Amp from "@thesvg/react/amp";
import ClaudeCode from "@thesvg/react/claude-code";
import Qwen from "@thesvg/react/qwen";
import Cline from "@thesvg/react/cline";
import CodexOpenai from "@thesvg/react/codex-openai";
import Cursor from "@thesvg/react/cursor";
import GoogleGemini from "@thesvg/react/google-gemini";
import GithubCopilot from "@thesvg/react/github-copilot";
import GooseCodename from "@thesvg/react/goose-codename";
import Junie from "@thesvg/react/junie";
import KiloCode from "@thesvg/react/kilo-code";
import Kimi from "@thesvg/react/kimi";
import MistralAi from "@thesvg/react/mistral-ai";
import Opencode from "@thesvg/react/opencode";

type SvgIcon = ForwardRefExoticComponent<SVGProps<SVGSVGElement> & RefAttributes<SVGSVGElement>>;

const DARK_INVERT_SLUGS = new Set(["github", "github-copilot-cli"]);

const BRAND_ICONS: Record<string, SvgIcon> = {
  github: Github,
  gitlab: Gitlab,
  jira_cloud: Jira,
  bitbucket: Bitbucket,
  linear: Linear,
  forgejo: Forgejo,
  gitea: Gitea,
  azuredevops: AzureAzureDevops,
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
  return (
    <Icon
      className={cn(className, DARK_INVERT_SLUGS.has(slug) && "dark:[filter:invert(1)]")}
      width={width}
      height={height}
    />
  );
}

export function hasBrandIcon(slug: string): boolean {
  return slug in BRAND_ICONS;
}

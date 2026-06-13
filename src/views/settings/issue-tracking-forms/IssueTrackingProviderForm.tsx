import type { IntegrationStatus } from "@/types/bindings";
import { GitHubForm } from "./GitHubForm";
import { JiraCloudForm } from "./JiraCloudForm";
import { LinearForm } from "./LinearForm";
import { GitLabForm } from "./GitLabForm";
import { ForgejoForm } from "./ForgejoForm";
import { GiteaForm } from "./GiteaForm";
import { AzureDevOpsForm } from "./AzureDevOpsForm";

interface Props {
  provider: string;
  integration: IntegrationStatus;
  fields: Record<string, string>;
  onFieldsChange: (fields: Record<string, string>) => void;
  showValidation?: boolean;
}

export function IssueTrackingProviderForm({
  provider,
  integration,
  fields,
  onFieldsChange,
  showValidation,
}: Props) {
  switch (provider) {
    case "github":
      return (
        <GitHubForm
          integration={integration}
          fields={fields}
          onFieldsChange={onFieldsChange}
          showValidation={showValidation}
        />
      );
    case "jira_cloud":
      return (
        <JiraCloudForm
          fields={fields}
          onFieldsChange={onFieldsChange}
          showValidation={showValidation}
        />
      );
    case "linear":
      return <LinearForm fields={fields} onFieldsChange={onFieldsChange} />;
    case "gitlab":
      return (
        <GitLabForm
          fields={fields}
          onFieldsChange={onFieldsChange}
          showValidation={showValidation}
        />
      );
    case "forgejo":
      return (
        <ForgejoForm
          integration={integration}
          fields={fields}
          onFieldsChange={onFieldsChange}
          showValidation={showValidation}
        />
      );
    case "gitea":
      return (
        <GiteaForm
          integration={integration}
          fields={fields}
          onFieldsChange={onFieldsChange}
          showValidation={showValidation}
        />
      );
    case "azuredevops":
      return (
        <AzureDevOpsForm
          fields={fields}
          onFieldsChange={onFieldsChange}
          showValidation={showValidation}
        />
      );
    default:
      return null;
  }
}

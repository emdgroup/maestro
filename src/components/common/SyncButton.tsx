import { useSyncGithubIssues, useSyncJiraIssues } from "@/services/project.service";
import { Button } from "@/ui/button";
import { Spinner } from "@/ui/spinner";

interface SyncButtonProps {
  projectId: number;
  provider: "github" | "jira";
  onSyncComplete: () => void;
}

export function SyncButton({ projectId, provider, onSyncComplete }: SyncButtonProps) {
  const { mutate: syncGithub, isPending: isGithubSyncing } = useSyncGithubIssues();
  const { mutate: syncJira, isPending: isJiraSyncing } = useSyncJiraIssues();

  const isLoading = isGithubSyncing || isJiraSyncing;

  function handleSync() {
    if (provider === "github") {
      // In real app, retrieve stored GitHub config from settings
      syncGithub(
        {
          projectId,
          owner: "example",
          repo: "example-repo",
          token: "token",
        },
        {
          onSuccess: () => {
            onSyncComplete();
          },
        },
      );
    } else if (provider === "jira") {
      // In real app, retrieve stored Jira config from settings
      syncJira(
        {
          projectId,
          host: "example.atlassian.net",
          email: "user@example.com",
          token: "token",
          jql: "status = Open",
        },
        {
          onSuccess: () => {
            onSyncComplete();
          },
        },
      );
    }
  }

  return (
    <Button onClick={handleSync} disabled={isLoading} title={`Sync from ${provider}`}>
      {isLoading ? (
        <>
          <Spinner />
          Syncing...
        </>
      ) : (
        `Sync from ${provider}`
      )}
    </Button>
  );
}

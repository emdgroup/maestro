import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { IssueTrackingSection } from "./IssueTrackingSection";
import type { IntegrationStatus, ProjectIssueTrackingConfig } from "@/types/bindings";

/// What `get_project_issue_tracking_config` resolves to, and whether it has resolved yet.
/// `App` keeps this query open for the whole session, so the section normally mounts with the
/// answer already in cache — `loading: false` on the very first render is the real-world case.
const config = vi.hoisted(() => ({
  current: null as ProjectIssueTrackingConfig | null,
  loading: false,
}));
const save = vi.hoisted(() => vi.fn());

vi.mock("@/services/integration.service", () => ({
  useProjectIssueTrackingConfig: () => ({
    data: config.loading ? undefined : config.current,
  }),
  useSaveProjectIssueTrackingConfig: () => ({ mutate: save, mutateAsync: save, isPending: false }),
  useDetectIssueTracking: () => ({ data: null }),
  PROVIDER_NAMES: { github: "GitHub" },
}));

/// The forms reach for provider lookup queries of their own; the section under test only cares
/// that a form appears at all.
vi.mock("@/views/settings/issue-tracking-forms/IssueTrackingProviderForm", () => ({
  IssueTrackingProviderForm: ({ provider }: { provider: string }) => (
    <div data-testid="provider-form">{provider}</div>
  ),
}));
vi.mock("@/views/project-picker/integrations-tab/IntegrationConnectDialog", () => ({
  IntegrationConnectDialog: () => null,
}));

const integrations: IntegrationStatus[] = [
  {
    id: "acct-1",
    provider: "github",
    connected: true,
    display_name: "octocat",
    source: "manual",
    instance_url: null,
  },
];

const storedConfig: ProjectIssueTrackingConfig = {
  provider: "github",
  integration_id: "acct-1",
  owner: "octocat",
  repo: "hello-world",
  project_path: null,
  team_id: null,
  project_key: null,
  project_name: null,
};

function renderSection(list: IntegrationStatus[] = integrations) {
  return render(<IssueTrackingSection projectId={1} issueTrackingIntegrations={list} />);
}

describe("IssueTrackingSection", () => {
  beforeEach(() => {
    save.mockReset();
    config.current = null;
    config.loading = false;
  });

  it("shows the stored config when the query is already resolved on mount", () => {
    config.current = storedConfig;

    renderSection();

    expect(screen.getByTestId("provider-form")).toHaveTextContent("github");
    expect(screen.getByRole("button", { name: /Remove/ })).toBeInTheDocument();
    // The "nothing configured yet" affordance must be gone.
    expect(screen.queryByRole("button", { name: /Add/ })).not.toBeInTheDocument();
  });

  it("shows the stored config when it arrives after mount", () => {
    config.loading = true;
    const { rerender } = renderSection();
    expect(screen.queryByTestId("provider-form")).not.toBeInTheDocument();

    config.loading = false;
    config.current = storedConfig;
    rerender(<IssueTrackingSection projectId={1} issueTrackingIntegrations={integrations} />);

    expect(screen.getByTestId("provider-form")).toHaveTextContent("github");
  });

  it("selects the account once the integrations list lands after the config", () => {
    config.current = storedConfig;
    const { rerender } = renderSection([]);
    expect(screen.queryByTestId("provider-form")).not.toBeInTheDocument();

    rerender(<IssueTrackingSection projectId={1} issueTrackingIntegrations={integrations} />);

    expect(screen.getByTestId("provider-form")).toHaveTextContent("github");
  });

  it("offers the provider chips when the project has no config", () => {
    renderSection();

    expect(screen.queryByTestId("provider-form")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add/ })).toBeInTheDocument();
  });

  it("does not re-save a config it only just loaded", () => {
    config.current = storedConfig;

    renderSection();

    expect(save).not.toHaveBeenCalled();
  });
});

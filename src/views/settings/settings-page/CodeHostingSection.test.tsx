import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CodeHostingSection } from "./CodeHostingSection";
import type { CodeHostingStatus } from "@/types/bindings";

const status = vi.hoisted(() => ({ current: null as CodeHostingStatus | null }));
const saveLandingMode = vi.hoisted(() => vi.fn());
/// The project's git remotes, swapped per test.
const remotes = vi.hoisted(() => ({ current: ["origin", "fork"] as string[] }));

vi.mock("@/services/project.service", () => ({
  useProjectRemotes: () => ({ data: remotes.current }),
}));

vi.mock("@/services/integration.service", async (importOriginal) => ({
  // `PROVIDER_NAMES` is a plain table and is what the card renders its labels from, so it is
  // kept rather than stubbed.
  ...(await importOriginal<typeof import("@/services/integration.service")>()),
  useCodeHostingStatus: () => ({ data: status.current, isLoading: false }),
  useSaveProjectLandingMode: () => ({ mutate: saveLandingMode, isPending: false }),
}));

/// The connect flow is the project picker's dialog, driven here exactly as the Issue tracking
/// page drives it. These tests are about whether the card offers it, not what it does.
vi.mock("@/views/project-picker/integrations-tab/IntegrationConnectDialog", () => ({
  IntegrationConnectDialog: ({ open, provider }: { open: boolean; provider: string }) =>
    open ? <div data-testid="connect-dialog">{provider}</div> : null,
}));

vi.mock("@/components/common/brand-icon/BrandIcon", () => ({
  BrandIcon: ({ slug }: { slug: string }) => <span data-testid={`brand-${slug}`} />,
}));

function statusOf(overrides: Partial<CodeHostingStatus> = {}): CodeHostingStatus {
  return {
    rung: "Ready",
    landing_mode: "Merge",
    remote: "origin",
    remote_url: "https://github.com/emdgroup/maestro.git",
    config: {
      provider: "github",
      host: "github.com",
      owner: "emdgroup",
      repo: "maestro",
      project_path: "emdgroup/maestro",
    },
    forge_supports_pull_requests: true,
    applied: false,
    ...overrides,
  };
}

function renderCard(overrides: Partial<CodeHostingStatus> = {}, remoteName: string | null = null) {
  status.current = statusOf(overrides);
  const onChange = vi.fn();
  render(<CodeHostingSection projectId={1} remoteName={remoteName} onChange={onChange} />);
  return onChange;
}

/// Its accessible name comes from the `Git remote` label, not from whichever remote is selected.
const remoteSelect = () => screen.getByRole("combobox", { name: /git remote/i });

describe("CodeHostingSection", () => {
  beforeEach(() => {
    saveLandingMode.mockClear();
    remotes.current = ["origin", "fork"];
  });

  it("shows the remote name and where it points", () => {
    renderCard();

    expect(screen.getByText("origin")).toBeTruthy();
    expect(screen.getByText("https://github.com/emdgroup/maestro.git")).toBeTruthy();
    expect(screen.getByText("GitHub")).toBeTruthy();
  });

  /// The reason this card exists: the Approve dialog tells people to connect the forge "in
  /// Settings", so Settings has to be somewhere they can actually do it.
  it("offers to connect a forge nothing has authenticated for", async () => {
    renderCard({ rung: "NotConnected" });

    await userEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(screen.getByTestId("connect-dialog").textContent).toBe("github");
  });

  it("does not offer to connect one that is already connected", () => {
    renderCard({ rung: "Ready" });

    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });

  /// Inviting someone to connect a forge that still could not open a pull request asks for work
  /// that changes nothing — the same rule the Approve dialog applies to its own invitation.
  it("does not offer to connect a forge it could not post to anyway", () => {
    renderCard({ rung: "NotConnected", forge_supports_pull_requests: false });

    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });

  it("says there is nothing to push to when the project has no remote", () => {
    renderCard({ rung: "NoRemote", remote: null, remote_url: null, config: null });

    expect(screen.getByText(/no git remote/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });

  it("reports a host it cannot name rather than staying silent", () => {
    renderCard({ rung: "ForgeUnknown", config: null, forge_supports_pull_requests: false });

    expect(screen.getByText(/does not recognise this host/i)).toBeTruthy();
    expect(screen.getByText("https://github.com/emdgroup/maestro.git")).toBeTruthy();
  });

  it("persists the landing mode as soon as it is picked", async () => {
    renderCard();

    await userEvent.click(screen.getByRole("combobox", { name: /when a task is approved/i }));
    await userEvent.click(await screen.findByRole("option", { name: /open a pull request/i }));

    expect(saveLandingMode).toHaveBeenCalledWith({ projectId: 1, landingMode: "PullRequest" });
  });

  /// The setting stays selectable before its forge is connected, so the card owes the user a
  /// sentence about what Approve will actually do in the meantime.
  it("says what will happen when the chosen mode cannot be honoured", () => {
    renderCard({ rung: "NotConnected", landing_mode: "PullRequest" });

    expect(screen.getByText(/Connect GitHub above to open pull requests/i)).toBeTruthy();
  });

  it("says nothing when the chosen mode is reachable", () => {
    renderCard({ rung: "Ready", landing_mode: "PullRequest" });

    expect(screen.queryByText(/Approve will merge locally/i)).toBeNull();
  });

  /// The remote picker sits here rather than on the card above, because the URL and forge beneath
  /// it are what the chosen remote resolves to. A card apart, the two could disagree on screen.
  it("persists the remote as soon as it is picked", async () => {
    const onChange = renderCard();

    await userEvent.click(remoteSelect());
    await userEvent.click(await screen.findByRole("option", { name: "fork" }));

    expect(onChange).toHaveBeenCalledWith({ remote_name: "fork" });
  });

  /// "Auto" is the absence of a choice, so it is stored as null rather than as whichever remote
  /// detection happened to land on when it was picked.
  it("stores auto-detect as no remote at all", async () => {
    const onChange = renderCard({}, "fork");

    await userEvent.click(remoteSelect());
    await userEvent.click(await screen.findByRole("option", { name: /auto-detect/i }));

    expect(onChange).toHaveBeenCalledWith({ remote_name: null });
  });

  /// A configured remote the repository no longer has must stay visible, or the picker would show
  /// "Auto-detect" while the stored setting says otherwise.
  it("still offers a configured remote the project no longer has", () => {
    remotes.current = ["origin"];
    renderCard({}, "gone");

    expect(remoteSelect().textContent).toContain("gone");
  });
});

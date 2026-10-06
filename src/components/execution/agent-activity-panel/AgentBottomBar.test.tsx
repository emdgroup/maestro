import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AgentBottomBar } from "./AgentBottomBar";

vi.mock("@/services/settings.service", () => ({ useSettings: () => ({ data: undefined }) }));

// Stands in for the real composer: all that matters here is that its local state survives.
vi.mock("../activity/compose-bar/ComposeBar", () => ({
  ComposeBar: () => {
    const [draft, setDraft] = useState("");
    return <textarea aria-label="draft" value={draft} onChange={(e) => setDraft(e.target.value)} />;
  },
}));

const props = {
  isSessionDead: false,
  composeBarWrapperRef: { current: null },
  composeBarRef: { current: null },
  onSend: () => {},
  onCancel: async () => {},
  isProcessing: true,
  commands: [],
  embeddedContext: false,
  sessionId: "s1",
  projectPath: null,
  configOptions: [],
  configValues: {},
  usageState: null,
  onConfigChange: async () => {},
  promptCapabilities: null,
};

describe("AgentBottomBar", () => {
  it("keeps the unsent draft across a permission request", () => {
    const { rerender } = render(<AgentBottomBar {...props} showCompose />);
    fireEvent.change(screen.getByLabelText("draft"), { target: { value: "half a thought" } });

    rerender(<AgentBottomBar {...props} showCompose={false} replacement={<p>Allow?</p>} />);
    expect(screen.getByText("Allow?")).toBeTruthy();

    rerender(<AgentBottomBar {...props} showCompose />);
    expect((screen.getByLabelText("draft") as HTMLTextAreaElement).value).toBe("half a thought");
  });
});

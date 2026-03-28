import { beforeEach, describe, expect, it } from "vitest";
import { useConfigStore } from "./configStore";

function resetStore() {
  useConfigStore.setState({
    model_default: "",
    mcp_allowlist: [],
    skills_default: [],
    isLoading: false,
    error: null,
  });
}

describe("configStore – initial state", () => {
  beforeEach(resetStore);

  it("has correct default values", () => {
    const s = useConfigStore.getState();
    expect(s.model_default).toBe("");
    expect(s.mcp_allowlist).toEqual([]);
    expect(s.skills_default).toEqual([]);
    expect(s.isLoading).toBe(false);
    expect(s.error).toBeNull();
  });
});

describe("configStore – setModelDefault", () => {
  beforeEach(resetStore);

  it("sets model_default", () => {
    useConfigStore.getState().setModelDefault("claude-opus-4-5");
    expect(useConfigStore.getState().model_default).toBe("claude-opus-4-5");
  });
});

describe("configStore – setMcpAllowlist", () => {
  beforeEach(resetStore);

  it("sets mcp_allowlist", () => {
    useConfigStore.getState().setMcpAllowlist(["filesystem", "web"]);
    expect(useConfigStore.getState().mcp_allowlist).toEqual(["filesystem", "web"]);
  });

  it("replaces previous list", () => {
    useConfigStore.getState().setMcpAllowlist(["filesystem"]);
    useConfigStore.getState().setMcpAllowlist(["web", "git"]);
    expect(useConfigStore.getState().mcp_allowlist).toEqual(["web", "git"]);
  });
});

describe("configStore – setSkillsDefault", () => {
  beforeEach(resetStore);

  it("sets skills_default", () => {
    useConfigStore.getState().setSkillsDefault(["rust", "python"]);
    expect(useConfigStore.getState().skills_default).toEqual(["rust", "python"]);
  });
});

describe("configStore – setLoading / setError / clearError", () => {
  beforeEach(resetStore);

  it("setLoading toggles isLoading", () => {
    useConfigStore.getState().setLoading(true);
    expect(useConfigStore.getState().isLoading).toBe(true);
    useConfigStore.getState().setLoading(false);
    expect(useConfigStore.getState().isLoading).toBe(false);
  });

  it("setError sets error string", () => {
    useConfigStore.getState().setError("something went wrong");
    expect(useConfigStore.getState().error).toBe("something went wrong");
  });

  it("clearError resets error to null", () => {
    useConfigStore.getState().setError("oops");
    useConfigStore.getState().clearError();
    expect(useConfigStore.getState().error).toBeNull();
  });
});

describe("configStore – setState (partial update)", () => {
  beforeEach(resetStore);

  it("merges partial config without affecting other fields", () => {
    useConfigStore.getState().setState({ model_default: "claude-opus-4-5" });
    const s = useConfigStore.getState();
    expect(s.model_default).toBe("claude-opus-4-5");
    expect(s.mcp_allowlist).toEqual([]); // untouched
  });

  it("ignores undefined keys", () => {
    useConfigStore.getState().setError("existing error");
    useConfigStore.getState().setState({ model_default: "m" });
    expect(useConfigStore.getState().error).toBe("existing error");
  });
});

describe("configStore – resetConfig / clearConfig", () => {
  beforeEach(resetStore);

  it("resetConfig restores all fields to defaults", () => {
    useConfigStore.getState().setModelDefault("claude-opus-4-5");
    useConfigStore.getState().setMcpAllowlist(["web"]);
    useConfigStore.getState().setError("err");
    useConfigStore.getState().resetConfig();
    const s = useConfigStore.getState();
    expect(s.model_default).toBe("");
    expect(s.mcp_allowlist).toEqual([]);
    expect(s.error).toBeNull();
  });

  it("clearConfig has same effect as resetConfig", () => {
    useConfigStore.getState().setModelDefault("x");
    useConfigStore.getState().clearConfig();
    expect(useConfigStore.getState().model_default).toBe("");
  });
});

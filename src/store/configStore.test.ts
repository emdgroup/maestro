import { beforeEach, describe, expect, it } from "vitest";
import { useConfigStore } from "./configStore";

function resetStore() {
  useConfigStore.setState({
    default_agent: null,
    default_model: null,
    isLoading: false,
    error: null,
  });
}

describe("configStore – initial state", () => {
  beforeEach(resetStore);

  it("has correct default values", () => {
    const s = useConfigStore.getState();
    expect(s.default_agent).toBeNull();
    expect(s.default_model).toBeNull();
    expect(s.isLoading).toBe(false);
    expect(s.error).toBeNull();
  });
});

describe("configStore – setDefaultAgent", () => {
  beforeEach(resetStore);

  it("sets default_agent", () => {
    useConfigStore.getState().setDefaultAgent("claude-code");
    expect(useConfigStore.getState().default_agent).toBe("claude-code");
  });

  it("clears default_agent with null", () => {
    useConfigStore.getState().setDefaultAgent("claude-code");
    useConfigStore.getState().setDefaultAgent(null);
    expect(useConfigStore.getState().default_agent).toBeNull();
  });
});

describe("configStore – setDefaultModel", () => {
  beforeEach(resetStore);

  it("sets default_model", () => {
    useConfigStore.getState().setDefaultModel("claude-opus-4-7");
    expect(useConfigStore.getState().default_model).toBe("claude-opus-4-7");
  });

  it("clears default_model with null", () => {
    useConfigStore.getState().setDefaultModel("claude-opus-4-7");
    useConfigStore.getState().setDefaultModel(null);
    expect(useConfigStore.getState().default_model).toBeNull();
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
    useConfigStore.getState().setState({ default_agent: "claude-code" });
    const s = useConfigStore.getState();
    expect(s.default_agent).toBe("claude-code");
    expect(s.default_model).toBeNull();
  });

  it("ignores undefined keys", () => {
    useConfigStore.getState().setError("existing error");
    useConfigStore.getState().setState({ default_agent: "claude-code" });
    expect(useConfigStore.getState().error).toBe("existing error");
  });
});

describe("configStore – resetConfig / clearConfig", () => {
  beforeEach(resetStore);

  it("resetConfig restores all fields to defaults", () => {
    useConfigStore.getState().setDefaultAgent("claude-code");
    useConfigStore.getState().setDefaultModel("claude-opus-4-7");
    useConfigStore.getState().setError("err");
    useConfigStore.getState().resetConfig();
    const s = useConfigStore.getState();
    expect(s.default_agent).toBeNull();
    expect(s.default_model).toBeNull();
    expect(s.error).toBeNull();
  });

  it("clearConfig has same effect as resetConfig", () => {
    useConfigStore.getState().setDefaultAgent("claude-code");
    useConfigStore.getState().clearConfig();
    expect(useConfigStore.getState().default_agent).toBeNull();
  });
});

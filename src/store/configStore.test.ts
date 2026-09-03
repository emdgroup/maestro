import { beforeEach, describe, expect, it } from "vitest";
import { useConfigStore } from "./configStore";

function resetStore() {
  useConfigStore.setState({
    isLoading: false,
    error: null,
  });
}

describe("configStore – initial state", () => {
  beforeEach(resetStore);

  it("has correct default values", () => {
    const s = useConfigStore.getState();
    expect(s.isLoading).toBe(false);
    expect(s.error).toBeNull();
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
    useConfigStore.getState().setError("existing error");
    useConfigStore.getState().setState({ isLoading: true });
    const s = useConfigStore.getState();
    expect(s.isLoading).toBe(true);
    expect(s.error).toBe("existing error");
  });

  it("ignores undefined keys", () => {
    useConfigStore.getState().setError("existing error");
    useConfigStore.getState().setState({});
    expect(useConfigStore.getState().error).toBe("existing error");
  });
});

describe("configStore – resetConfig", () => {
  beforeEach(resetStore);

  it("resetConfig restores all fields to defaults", () => {
    useConfigStore.getState().setLoading(true);
    useConfigStore.getState().setError("err");
    useConfigStore.getState().resetConfig();
    const s = useConfigStore.getState();
    expect(s.isLoading).toBe(false);
    expect(s.error).toBeNull();
  });
});

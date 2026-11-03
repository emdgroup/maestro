import { describe, it, expect } from "vitest";
import { connectionChannelId, connectionKeyStr } from "./connection-utils";

describe("connection ids", () => {
  it("keys the stores with a colon", () => {
    expect(connectionKeyStr({ type: "local" })).toBe("local");
    expect(connectionKeyStr({ type: "ssh", id: 3 })).toBe("ssh:3");
  });

  /** The backend's `connection_key_id`: a listener on any other spelling hears nothing. */
  it("names event channels with a dash", () => {
    expect(connectionChannelId({ type: "local" })).toBe("local");
    expect(connectionChannelId({ type: "ssh", id: 3 })).toBe("ssh-3");
    expect(connectionChannelId({ type: "wsl", id: 4 })).toBe("wsl-4");
    expect(connectionChannelId({ type: "docker", id: 5 })).toBe("docker-5");
  });
});

import { describe, expect, it } from "vitest";
import { catalogMatch, filterServers, needsValue } from "./mcp";
import type { McpCatalogEntry, McpServerConfig } from "@/types/bindings";

const server = (name: string, patch: Partial<McpServerConfig> = {}): McpServerConfig => ({
  name,
  transport: "stdio",
  command: "npx",
  args: [],
  env: [],
  url: null,
  headers: [],
  agents: [],
  catalog_id: null,
  ...patch,
});

describe("needsValue", () => {
  it("spots registry placeholders", () => {
    expect(needsValue("GITHUB_TOKEN={token}")).toBe(true);
    expect(needsValue("--directory <path>")).toBe(true);
    expect(needsValue("Bearer abc")).toBe(false);
    expect(needsValue("${HOME}/x")).toBe(false);
  });
});

describe("filterServers", () => {
  it("matches name, command, url and args", () => {
    const servers = [
      server("context7", { args: ["-y", "@upstash/context7-mcp"] }),
      server("remote", { transport: "http", command: null, url: "https://netdata.cloud/mcp" }),
    ];
    expect(filterServers(servers, "")).toHaveLength(2);
    expect(filterServers(servers, "UPSTASH").map((s) => s.name)).toEqual(["context7"]);
    expect(filterServers(servers, "netdata").map((s) => s.name)).toEqual(["remote"]);
  });
});

const entry = (id: string, packages: string[], urls: string[] = []): McpCatalogEntry => ({
  id,
  name: id,
  description: "",
  icon_url: null,
  stars: null,
  repo_url: null,
  install: server(id),
  packages,
  urls,
});

describe("catalogMatch", () => {
  const entries = [
    entry(
      "io.github.upstash/context7",
      ["@upstash/context7-mcp"],
      ["https://mcp.context7.com/mcp"],
    ),
    entry("io.github.github/github-mcp-server", ["ghcr.io/github/github-mcp-server:1.12.2"]),
    entry("microsoft/markitdown", ["markitdown-mcp"]),
  ];

  it("prefers the id it was installed with", () => {
    const installed = server("x", { catalog_id: "microsoft/markitdown" });
    expect(catalogMatch(installed, entries)?.id).toBe("microsoft/markitdown");
  });

  it("recognises a package whatever its version", () => {
    const npm = server("docs", { args: ["-y", "@upstash/context7-mcp@latest"] });
    expect(catalogMatch(npm, entries)?.id).toBe("io.github.upstash/context7");
    const pypi = server("md", { command: "uvx", args: ["markitdown-mcp==0.1"] });
    expect(catalogMatch(pypi, entries)?.id).toBe("microsoft/markitdown");
    const oci = server("gh", {
      command: "docker",
      args: ["run", "-i", "--rm", "ghcr.io/github/github-mcp-server"],
    });
    expect(catalogMatch(oci, entries)?.id).toBe("io.github.github/github-mcp-server");
  });

  it("recognises a remote by its URL", () => {
    const remote = server("c7", {
      transport: "http",
      command: null,
      url: "https://mcp.context7.com/mcp/",
    });
    expect(catalogMatch(remote, entries)?.id).toBe("io.github.upstash/context7");
  });

  it("leaves an unknown server unmatched", () => {
    expect(catalogMatch(server("mine", { args: ["./server.js"] }), entries)).toBeUndefined();
  });
});

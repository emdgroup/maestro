import { describe, expect, it } from "vitest";
import {
  catalogMatch,
  filterServers,
  guessName,
  needsValue,
  parseEnvLines,
  parseMcpJson,
  splitCommand,
  toMcpJson,
  usedVariables,
} from "./mcp";
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

describe("the STDIO command", () => {
  it("splits like a shell, quotes kept whole and Windows paths intact", () => {
    expect(splitCommand(`npx -y pkg "C:\\My Files" ''`)).toEqual([
      "npx",
      "-y",
      "pkg",
      "C:\\My Files",
      "",
    ]);
  });

  it("names the server after its package, and finds the variables it uses", () => {
    const server = { transport: "stdio", url: null, command: "npx" };
    expect(
      guessName({ ...server, args: ["-y", "@modelcontextprotocol/server-filesystem@1.0"] }),
    ).toBe("filesystem");
    expect(guessName({ ...server, command: "uvx", args: ["mcp-server-git"] })).toBe("git");
    expect(
      guessName({ transport: "http", command: null, args: [], url: "https://mcp.linear.app/mcp" }),
    ).toBe("linear");
    expect(usedVariables(["--root", "${ROOT}", "${ROOT}/x"])).toEqual(["ROOT"]);
  });

  it("reads .env lines", () => {
    expect(parseEnvLines('# token\nexport TOKEN="abc"\n\nLOG=debug=1')).toEqual([
      { key: "TOKEN", value: "abc" },
      { key: "LOG", value: "debug=1" },
    ]);
  });
});

describe("MCP JSON", () => {
  it("takes the first server of an mcpServers block and says how many it left", () => {
    const parsed = parseMcpJson(
      JSON.stringify({
        mcpServers: {
          github: { command: "npx", args: ["-y", "gh"], env: { TOKEN: "x" } },
          linear: { url: "https://mcp.linear.app/sse", type: "sse" },
        },
      }),
    );
    expect(parsed).toMatchObject({
      skipped: 1,
      server: {
        name: "github",
        transport: "stdio",
        command: "npx",
        args: ["-y", "gh"],
        env: [{ key: "TOKEN", value: "x", secret: false }],
      },
    });
  });

  it("reads one remote server, headers as secrets, and writes it back", () => {
    const parsed = parseMcpJson(
      '{"url":"https://x.dev/mcp","headers":{"Authorization":"Bearer t"}}',
    );
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.server.transport).toBe("http");
    expect(parsed.server.headers).toEqual([
      { key: "Authorization", value: "Bearer t", secret: true },
    ]);
    const written = JSON.parse(
      toMcpJson({
        name: "x",
        transport: "http",
        command: null,
        args: [],
        env: [],
        url: "https://x.dev/mcp",
        headers: [{ key: "Authorization", value: "Bearer t", secret: true }],
        agents: [],
        catalog_id: null,
        oauth: null,
      }),
    );
    expect(written).toEqual({
      mcpServers: {
        x: { type: "http", url: "https://x.dev/mcp", headers: { Authorization: "Bearer t" } },
      },
    });
    expect(parseMcpJson("{nope")).toHaveProperty("error");
  });
});

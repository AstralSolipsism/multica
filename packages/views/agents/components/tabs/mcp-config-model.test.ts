// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  dedupeMcpServerName,
  listManagedMcpServers,
  mcpTransportLabel,
  removeManagedMcpServer,
  sanitizeMcpServerName,
  suggestMcpServerName,
  upsertManagedMcpServer,
} from "./mcp-config-model";

describe("mcp config compatibility model", () => {
  it("uses the same user-facing transport names across MCP surfaces", () => {
    expect(mcpTransportLabel("stdio")).toBe("STDIO");
    expect(mcpTransportLabel("LOCAL")).toBe("STDIO");
    expect(mcpTransportLabel("http")).toBe("Streamable HTTP");
    expect(mcpTransportLabel("remote")).toBe("Streamable HTTP");
    expect(mcpTransportLabel("streamable-http")).toBe("Streamable HTTP");
    expect(mcpTransportLabel("sse")).toBe("SSE");
    expect(mcpTransportLabel(" websocket ")).toBe("websocket");
    expect(mcpTransportLabel("   ")).toBe("Unknown");
  });

  it("reads canonical and historical OpenCode-native containers without duplication", () => {
    const servers = listManagedMcpServers({
      mcpServers: { shared: { command: "canonical" } },
      mcp: {
        shared: { type: "local", command: ["native"] },
        legacy: { type: "remote", url: "https://example.test/mcp" },
      },
    });

    expect(servers.map(({ name, container }) => ({ name, container }))).toEqual([
      { name: "legacy", container: "mcp" },
      { name: "shared", container: "mcpServers" },
    ]);
  });

  it("updates a single legacy entry while preserving unknown document fields", () => {
    const value = {
      provider: "opencode",
      mcp: {
        legacy: { type: "remote", url: "https://old.test/mcp" },
        sibling: { type: "local", command: ["node", "server.js"] },
      },
    };
    const legacy = listManagedMcpServers(value).find(
      (server) => server.name === "legacy",
    );
    expect(legacy).toBeDefined();

    expect(
      upsertManagedMcpServer(
        value,
        legacy!,
        "legacy",
        { type: "remote", url: "https://new.test/mcp" },
      ),
    ).toEqual({
      provider: "opencode",
      mcp: {
        legacy: { type: "remote", url: "https://new.test/mcp" },
        sibling: { type: "local", command: ["node", "server.js"] },
      },
    });
  });

  it("returns null only when deleting the last value from an otherwise empty document", () => {
    const value = { mcpServers: { fetch: { command: "uvx" } } };
    const [fetch] = listManagedMcpServers(value);
    expect(removeManagedMcpServer(value, fetch!)).toBeNull();

    const withMetadata = { version: 1, ...value };
    const [withMetadataFetch] = listManagedMcpServers(withMetadata);
    expect(removeManagedMcpServer(withMetadata, withMetadataFetch!)).toEqual({
      version: 1,
    });
  });
});

// Canonical matrix for the create-time default name. The dialog test covers
// the wiring (fill until the user edits the name); the derivation and
// collision rules live here so they run without a DOM.
describe("suggestMcpServerName", () => {
  const suggest = (
    source: Parameters<typeof suggestMcpServerName>[0],
    existing: string[] = [],
  ) => suggestMcpServerName(source, new Set(existing));

  it.each([
    ["Fetch Server!", "fetch-server"],
    ["@modelcontextprotocol/server-github", "modelcontextprotocol-server-github"],
    ["...--__", ""],
    ["Already_Legal-1", "already_legal-1"],
  ])("sanitizes %j to %j", (raw, expected) => {
    expect(sanitizeMcpServerName(raw)).toBe(expected);
  });

  it.each([
    ["npx", ["-y", "@modelcontextprotocol/server-github"], "server-github"],
    ["npx", ["-y", "mcp-server-fetch"], "mcp-server-fetch"],
    ["uvx", ["mcp-server-fetch"], "mcp-server-fetch"],
    ["uvx", ["--from", "mcp-package", "mcp-tool"], "mcp-tool"],
    ["npm", ["exec", "-y", "@scope/name"], "name"],
    ["docker", ["run", "--rm", "-it", "acme/mcp-tools:latest"], "mcp-tools"],
    ["docker", ["run", "-e", "KEY=VALUE", "img"], "img"],
    ["node", ["/opt/mcp/dist/server.js"], "server"],
    ["/usr/local/bin/github-mcp", [], "github-mcp"],
    ["C:\\tools\\filesystem-server.exe", [], "filesystem-server-exe"],
  ])(
    "derives %j with args %j from the package or binary, not the launcher",
    (command, args, expected) => {
      expect(suggest({ transport: "stdio", command, args, url: "" })).toBe(
        expected,
      );
    },
  );

  it("suggests nothing for a bare launcher or empty command", () => {
    expect(suggest({ transport: "stdio", command: "npx", args: [], url: "" })).toBe("");
    expect(suggest({ transport: "stdio", command: "npx", args: ["-y"], url: "" })).toBe("");
    expect(suggest({ transport: "stdio", command: "", args: [], url: "" })).toBe("");
  });

  it.each([
    ["https://mcp.notion.com/mcp", "notion"],
    ["https://api.githubcopilot.com/mcp/", "githubcopilot"],
    ["https://www.example.com/sse", "example"],
    ["http://localhost:8080/mcp", "localhost"],
    ["http://192.168.1.10:8080/", "192-168-1-10"],
    ["https://mcp.internal/", "mcp"],
  ])("derives the registrable name from %s", (url, expected) => {
    expect(suggest({ transport: "http", command: "", args: [], url })).toBe(
      expected,
    );
  });

  it("suggests nothing for a URL that does not parse yet", () => {
    expect(suggest({ transport: "http", command: "", args: [], url: "not a url" })).toBe("");
  });

  it("suffixes collisions instead of reusing a taken name", () => {
    const source = {
      transport: "stdio" as const,
      command: "npx",
      args: ["server-github"],
      url: "",
    };
    expect(suggest(source, ["server-github"])).toBe("server-github-2");
    expect(suggest(source, ["server-github", "server-github-2"])).toBe(
      "server-github-3",
    );
  });

  it("returns empty when the base is empty, never a bare suffix", () => {
    expect(dedupeMcpServerName("", new Set())).toBe("");
  });
});

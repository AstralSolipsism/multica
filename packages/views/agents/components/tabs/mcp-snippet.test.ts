// @vitest-environment node

import { describe, expect, it } from "vitest";
import { parseMcpSnippet, splitCommandLine } from "./mcp-snippet";

// Canonical matrix for the paste-assistant parser. The dialog test covers the
// wiring (fill on apply, draft kept on error); every accepted/rejected shape
// lives here so it runs without a DOM.

describe("splitCommandLine", () => {
  it.each([
    ["npx -y @scope/server", ["npx", "-y", "@scope/server"]],
    ['cmd --header "Authorization: Bearer x"', ["cmd", "--header", "Authorization: Bearer x"]],
    ["cmd 'single quoted'", ["cmd", "single quoted"]],
    ["  padded   tokens  ", ["padded", "tokens"]],
    ['cmd ""', ["cmd", ""]],
  ])("splits %j", (input, expected) => {
    expect(splitCommandLine(input)).toEqual(expected);
  });

  it.each(['cmd "unclosed', "cmd 'unclosed"])(
    "rejects an unclosed quote in %j",
    (input) => {
      expect(splitCommandLine(input)).toBeNull();
    },
  );
});

describe("parseMcpSnippet", () => {
  it("parses an mcpServers wrapper and carries the entry name", () => {
    const result = parseMcpSnippet(
      JSON.stringify({
        mcpServers: {
          github: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
            env: { GITHUB_TOKEN: "x" },
          },
        },
      }),
    );
    expect(result).toEqual({
      ok: true,
      name: "github",
      config: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: "x" },
      },
    });
  });

  it("parses the VS Code servers wrapper", () => {
    const result = parseMcpSnippet(
      '{"servers": {"fetch": {"url": "https://fetch.example/mcp"}}}',
    );
    expect(result).toEqual({
      ok: true,
      name: "fetch",
      config: { url: "https://fetch.example/mcp" },
    });
  });

  it("parses a bare server object without a name", () => {
    const result = parseMcpSnippet(
      '{"command": "uvx", "args": ["mcp-server-fetch"], "timeout": 30}',
    );
    expect(result).toEqual({
      ok: true,
      name: null,
      config: { command: "uvx", args: ["mcp-server-fetch"], timeout: 30 },
    });
  });

  it("splits a launch command line into command and args without executing it", () => {
    const result = parseMcpSnippet("npx -y @modelcontextprotocol/server-github");
    expect(result).toEqual({
      ok: true,
      name: null,
      config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
    });
  });

  it("treats a lone URL as an HTTP endpoint", () => {
    const result = parseMcpSnippet("https://mcp.example.com/mcp");
    expect(result).toEqual({
      ok: true,
      name: null,
      config: { type: "http", url: "https://mcp.example.com/mcp" },
    });
  });

  it("rejects an empty snippet", () => {
    expect(parseMcpSnippet("   ")).toEqual({ ok: false, error: "empty" });
  });

  it("rejects broken JSON with the parser detail", () => {
    const result = parseMcpSnippet("{invalid");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_json");
  });

  it.each(['[1,2]', '[{"command": "x"}]'])(
    "rejects non-object JSON %j",
    (input) => {
      expect(parseMcpSnippet(input)).toEqual({ ok: false, error: "not_object" });
    },
  );

  it("rejects an empty server wrapper", () => {
    expect(parseMcpSnippet('{"mcpServers": {}}')).toEqual({
      ok: false,
      error: "no_servers",
    });
  });

  it("rejects a multi-server wrapper and lists the names", () => {
    const result = parseMcpSnippet(
      '{"mcpServers": {"one": {"command": "a"}, "two": {"command": "b"}}}',
    );
    expect(result).toEqual({
      ok: false,
      error: "multiple_servers",
      detail: "one, two",
    });
  });

  it("rejects a wrapper entry that is not an object", () => {
    expect(parseMcpSnippet('{"mcpServers": {"x": "npx"}}')).toEqual({
      ok: false,
      error: "not_object",
    });
  });

  it("rejects an object with neither command nor url", () => {
    expect(parseMcpSnippet('{"args": ["-y"]}')).toEqual({
      ok: false,
      error: "missing_target",
    });
  });

  it("rejects an empty command line", () => {
    expect(parseMcpSnippet('""')).toEqual({
      ok: false,
      error: "missing_target",
    });
  });

  it("rejects an unclosed quote in a command line", () => {
    expect(parseMcpSnippet('cmd "unclosed')).toEqual({
      ok: false,
      error: "unbalanced_quotes",
    });
  });
});

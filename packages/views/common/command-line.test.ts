// @vitest-environment node
import { describe, expect, it } from "vitest";
import { formatCommandLine, parseCommandLine } from "./command-line";

// Canonical matrix for the shared command-line tokenizer/formatter. Consumers
// (runtime profiles, MCP snippet assistant) keep only their own wiring tests.
describe("parseCommandLine", () => {
  it("splits a pasted executable and fixed args", () => {
    expect(parseCommandLine("agent --model composer-2.5")).toEqual({
      ok: true,
      commandName: "agent",
      fixedArgs: ["--model", "composer-2.5"],
    });
  });

  it("preserves quoted whitespace and escaped characters", () => {
    expect(parseCommandLine(`agent --flag "a b c" path\\ with\\ spaces`)).toEqual({
      ok: true,
      commandName: "agent",
      fixedArgs: ["--flag", "a b c", "path with spaces"],
    });
  });

  it("rejects shell control syntax", () => {
    expect(parseCommandLine("agent && rm -rf /")).toEqual({
      ok: false,
      error: "shell_syntax",
    });
    expect(parseCommandLine("agent | tee out")).toEqual({
      ok: false,
      error: "shell_syntax",
    });
  });

  it("rejects shell expansion syntax", () => {
    expect(parseCommandLine("agent --path $HOME/bin")).toEqual({
      ok: false,
      error: "shell_expansion",
    });
    expect(parseCommandLine("agent --path $(which foo)")).toEqual({
      ok: false,
      error: "shell_expansion",
    });
  });

  it("allows literal shell-looking characters inside single quotes", () => {
    expect(parseCommandLine("agent --note '$5 reward `literal`'")).toEqual({
      ok: true,
      commandName: "agent",
      fixedArgs: ["--note", "$5 reward `literal`"],
    });
  });

  it("rejects unclosed quotes", () => {
    expect(parseCommandLine(`agent --flag "unterminated`)).toEqual({
      ok: false,
      error: "unclosed_quote",
    });
  });

  it("rejects a trailing escape", () => {
    expect(parseCommandLine("agent \\")).toEqual({
      ok: false,
      error: "trailing_escape",
    });
  });
});

describe("formatCommandLine", () => {
  it("quotes args that need shell escaping for display", () => {
    expect(formatCommandLine("agent", ["--flag", "a b c"])).toBe(
      'agent --flag "a b c"',
    );
  });
});

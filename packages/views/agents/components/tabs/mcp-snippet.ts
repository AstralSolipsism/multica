import { isRecord } from "./mcp-config-model";

/**
 * Parsing for the paste-a-snippet assistant in the MCP server dialog.
 *
 * The shapes accepted here are the ones MCP server docs actually publish:
 *   - a desktop-client block:  {"mcpServers": {"name": {...}}}  (VS Code
 *     uses {"servers": {...}} for the same thing)
 *   - one bare server object:  {"command": "...", "args": [...]} or
 *     {"url": "...", "headers": {...}}
 *   - a launch command line:   npx -y @scope/server
 *   - a bare endpoint URL:     https://mcp.example.com/mcp
 *
 * Everything here is string parsing into form fields. A pasted command line
 * is never executed — it only fills Command / Startup arguments.
 */

export type McpSnippetError =
  | "empty"
  | "invalid_json"
  | "not_object"
  | "no_servers"
  | "multiple_servers"
  | "missing_target"
  | "unbalanced_quotes";

export type McpSnippetResult =
  | { ok: true; name: string | null; config: Record<string, unknown> }
  | { ok: false; error: McpSnippetError; detail?: string };

/**
 * Split a copied command line into tokens on whitespace, honoring single and
 * double quotes so `--header "Authorization: Bearer x"` survives as one
 * token. No expansion, no execution — the result is data for the form.
 * Returns null on an unclosed quote.
 */
export function splitCommandLine(input: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  // Tracks a token that is only quotes (`cmd ""` → ["cmd", ""]) so the
  // empty-but-explicit argument is not lost.
  let started = false;
  for (const char of input) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (quote !== null) return null;
  if (started) tokens.push(current);
  return tokens;
}

function finalize(
  name: string | null,
  config: Record<string, unknown>,
): McpSnippetResult {
  if (config.command === undefined && config.url === undefined) {
    return { ok: false, error: "missing_target" };
  }
  return { ok: true, name, config };
}

function parseJsonSnippet(trimmed: string): McpSnippetResult {
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    return {
      ok: false,
      error: "invalid_json",
      detail: error instanceof Error ? error.message : "invalid JSON",
    };
  }
  if (!isRecord(value)) return { ok: false, error: "not_object" };

  // A wrapper with one entry carries the server name as its key. More than
  // one entry would mean silently dropping servers the user asked for, so it
  // is an error with the names listed, not a quiet first-wins pick.
  for (const wrapperKey of ["mcpServers", "servers"] as const) {
    const wrapper = value[wrapperKey];
    if (!isRecord(wrapper)) continue;
    const entries = Object.entries(wrapper);
    if (entries.length === 0) return { ok: false, error: "no_servers" };
    if (entries.length > 1) {
      return {
        ok: false,
        error: "multiple_servers",
        detail: entries.map(([entryName]) => entryName).join(", "),
      };
    }
    const [name, config] = entries[0]!;
    if (!isRecord(config)) return { ok: false, error: "not_object" };
    return finalize(name, config);
  }

  return finalize(null, value);
}

function parseCommandLineSnippet(trimmed: string): McpSnippetResult {
  // A lone URL is an endpoint, not a command to launch.
  if (/^https?:\/\/\S+$/.test(trimmed)) {
    return { ok: true, name: null, config: { type: "http", url: trimmed } };
  }
  const tokens = splitCommandLine(trimmed);
  if (tokens === null) return { ok: false, error: "unbalanced_quotes" };
  const [command, ...args] = tokens;
  if (!command || command.trim() === "") {
    return { ok: false, error: "missing_target" };
  }
  return {
    ok: true,
    name: null,
    config: args.length > 0 ? { command, args } : { command },
  };
}

export function parseMcpSnippet(text: string): McpSnippetResult {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, error: "empty" };
  // `{` and `[` unambiguously start JSON; anything else is a command line or
  // a bare URL. A bare number / quoted string stays on the command path,
  // where the resulting field value at least shows the user what they pasted.
  return trimmed.startsWith("{") || trimmed.startsWith("[")
    ? parseJsonSnippet(trimmed)
    : parseCommandLineSnippet(trimmed);
}

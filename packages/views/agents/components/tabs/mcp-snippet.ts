import { parseCommandLine } from "../../../common/command-line";
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
  | "unbalanced_quotes"
  | "unsupported_syntax";

export type McpSnippetResult =
  | { ok: true; name: string | null; config: Record<string, unknown> }
  | { ok: false; error: McpSnippetError; detail?: string };

/**
 * The MCP entry's thin wrapper over the shared command-line tokenizer (see
 * packages/views/common/command-line.ts), keeping the dialog's `string[] |
 * null` contract: null on any rejected line — unclosed quote, dangling
 * escape, or shell syntax the form cannot represent.
 */
export function splitCommandLine(input: string): string[] | null {
  const parsed = parseCommandLine(input);
  return parsed.ok ? [parsed.commandName, ...parsed.fixedArgs] : null;
}

/**
 * A snippet is only usable when it carries a launchable target: a non-empty
 * command string (or a command token array with at least one non-empty
 * entry) or a non-empty url string. Anything else — `{"command": null}`,
 * `{"url": 42}`, `{}` — must be rejected BEFORE the dialog touches the
 * draft, or applying it would silently wipe fields the user already filled.
 */
function hasUsableTarget(config: Record<string, unknown>): boolean {
  const { command, url } = config;
  if (typeof command === "string" && command.trim() !== "") return true;
  if (
    Array.isArray(command) &&
    command.some((part) => typeof part === "string" && part.trim() !== "")
  ) {
    return true;
  }
  return typeof url === "string" && url.trim() !== "";
}

function finalize(
  name: string | null,
  config: Record<string, unknown>,
): McpSnippetResult {
  if (!hasUsableTarget(config)) return { ok: false, error: "missing_target" };
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
  const parsed = parseCommandLine(trimmed);
  if (!parsed.ok) {
    return {
      ok: false,
      error:
        parsed.error === "unclosed_quote"
          ? "unbalanced_quotes"
          : parsed.error === "empty"
            ? "empty"
            : "unsupported_syntax",
    };
  }
  const { commandName, fixedArgs } = parsed;
  return {
    ok: true,
    name: null,
    config: fixedArgs.length > 0
      ? { command: commandName, args: fixedArgs }
      : { command: commandName },
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

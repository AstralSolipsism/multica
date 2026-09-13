import { parseCommandLine } from "../../../common/command-line";
import { isRecord, mcpTransport } from "./mcp-config-model";

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
 * A snippet is only usable when the target the dialog will ACTUALLY use is
 * launchable. The check mirrors routing: `mcpTransport` (the same classifier
 * `formFromConfig` uses) selects STDIO whenever `command` is present — even
 * an array — or the type says `local`/`stdio`; in that case the command must
 * be a non-empty string or an array whose FIRST element is a non-empty
 * string (element 0 becomes the executable; later elements are arguments and
 * may legitimately be empty). A valid `url` sitting next to a broken stdio
 * target must not rescue the snippet — the form would read the empty
 * command and drop the url. Otherwise the url must be a non-empty string.
 * Anything failing this — `{"command": null}`, `{"command": ["", "--help"],
 * "url": "..."}`, `{"type": "stdio", "url": "..."}` — must be rejected
 * BEFORE the dialog touches the draft, or applying it would silently wipe
 * fields the user already filled.
 */
function hasUsableTarget(config: Record<string, unknown>): boolean {
  if (mcpTransport(config) === "stdio") {
    const { command } = config;
    if (typeof command === "string") return command.trim() !== "";
    if (Array.isArray(command)) {
      const executable = command[0];
      return typeof executable === "string" && executable.trim() !== "";
    }
    return false;
  }
  const { url } = config;
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

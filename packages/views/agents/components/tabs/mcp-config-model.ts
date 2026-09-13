export { mcpTransportLabel } from "../../../common/mcp-transport";

export type McpConfigContainer = "mcpServers" | "mcp";

export type ManagedMcpServer = {
  name: string;
  config: Record<string, unknown>;
  container: McpConfigContainer;
  transport: string;
  enabled: boolean;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The only grammar the create/rename validation accepts for NEW names. */
export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Turn an arbitrary token (hostname label, package name, file name) into a
 * legal server-name base: lowercase, every run of illegal characters folded
 * into one hyphen, no leading/trailing separators. Returns "" when nothing
 * usable remains — callers treat that as "no suggestion", never as a name.
 */
export function sanitizeMcpServerName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}

/**
 * Resolve collisions against the names already in use: `base`, then
 * `base-2`, `base-3`, … matching the suffix style people apply by hand.
 * Returns "" when the base is empty or the bounded search is exhausted —
 * the form's required-field validation already covers the empty case.
 */
export function dedupeMcpServerName(
  base: string,
  existingNames: Set<string>,
): string {
  if (base === "") return "";
  if (!existingNames.has(base)) return base;
  for (let suffix = 2; suffix <= 100; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!existingNames.has(candidate)) return candidate;
  }
  return "";
}

// Launchers whose own name says nothing about the server they start: the
// meaningful token is the package / image / script argument, not `npx`.
const LAUNCHER_COMMANDS = new Set([
  "npx",
  "uvx",
  "bunx",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "deno",
  "docker",
  "podman",
  "node",
  "python",
  "python3",
  "uv",
]);

// Flags that consume the following token, so the scanner does not mistake
// that value for the package (`uvx --from <pkg>`, `docker -e KEY=VALUE`).
const VALUE_FLAGS = new Set([
  "--from",
  "-p",
  "--package",
  "--image",
  "-e",
  "--env",
  "--entrypoint",
  "-w",
  "--workdir",
  "-v",
  "--volume",
]);

// Launcher subcommand words that precede the package (`npm exec`, `uv tool run`).
const LAUNCHER_SUBCOMMANDS = new Set(["exec", "dlx", "run", "x", "tool"]);

function basename(token: string): string {
  const normalized = token.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function tokenToNameBase(token: string): string {
  // npm scope: @scope/name → name
  let value = /^@[^/]+\/(.+)$/.exec(token)?.[1] ?? token;
  value = basename(value);
  // Container image tag or digest: repo/name:tag → repo/name
  value = value.replace(/[:@][^:@/]*$/, "");
  // Script extension: server.js → server
  value = value.replace(/\.(js|mjs|cjs|ts|py|sh|rb)$/i, "");
  return sanitizeMcpServerName(value);
}

function stdioNameBase(command: string, args: string[]): string {
  const cmd = basename(command.trim());
  if (cmd === "") return "";
  if (!LAUNCHER_COMMANDS.has(cmd.toLowerCase())) return tokenToNameBase(cmd);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]?.trim() ?? "";
    if (token === "") continue;
    if (VALUE_FLAGS.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    if (LAUNCHER_SUBCOMMANDS.has(token.toLowerCase())) continue;
    const base = tokenToNameBase(token);
    if (base !== "") return base;
  }
  // A bare launcher (`npx` with no package yet) has no meaningful name to
  // give — leave the field empty rather than naming every server "npx".
  return "";
}

function urlNameBase(rawUrl: string): string {
  let hostname: string;
  try {
    hostname = new URL(rawUrl.trim()).hostname;
  } catch {
    return "";
  }
  if (hostname === "") return "";
  const labels = hostname.replace(/^www\./, "").split(".");
  // Numeric hosts (IP addresses) have no readable label to pick — keep the
  // whole address rather than a meaningless octet.
  if (labels.every((label) => /^\d+$/.test(label))) {
    return sanitizeMcpServerName(hostname);
  }
  // `mcp.example.com` → example, `localhost` → localhost: the registrable
  // name is the last label once the TLD is dropped.
  const withoutTld = labels.length > 1 ? labels.slice(0, -1) : labels;
  return sanitizeMcpServerName(withoutTld[withoutTld.length - 1] ?? "");
}

/**
 * The default name offered while creating a server: derived from what the
 * user already typed (the package the command launches, or the endpoint's
 * hostname) and deduplicated against the names in use. Empty string means
 * "nothing worth suggesting yet". Editing never calls this — saved names are
 * identity, and rewriting them would break that.
 */
export function suggestMcpServerName(
  source: {
    transport: "stdio" | "http";
    command: string;
    args: string[];
    url: string;
  },
  existingNames: Set<string>,
): string {
  const base =
    source.transport === "stdio"
      ? stdioNameBase(source.command, source.args)
      : urlNameBase(source.url);
  return dedupeMcpServerName(base, existingNames);
}

export function mcpTransport(config: Record<string, unknown>): string {
  const type = typeof config.type === "string" ? config.type.toLowerCase() : "";
  if (config.command || type === "local" || type === "stdio") return "stdio";
  if (type === "sse") return "sse";
  if (
    config.url ||
    type === "remote" ||
    type === "http" ||
    type === "streamable-http"
  ) {
    return "http";
  }
  return "unknown";
}

export function listManagedMcpServers(value: unknown): ManagedMcpServer[] {
  if (!isRecord(value)) return [];

  const out: ManagedMcpServer[] = [];
  const seen = new Set<string>();
  for (const container of ["mcpServers", "mcp"] as const) {
    const raw = value[container];
    if (!isRecord(raw)) continue;
    for (const [name, entry] of Object.entries(raw)) {
      if (seen.has(name) || !isRecord(entry)) continue;
      seen.add(name);
      out.push({
        name,
        config: entry,
        container,
        transport: mcpTransport(entry),
        enabled: entry.enabled !== false && entry.disabled !== true,
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function upsertManagedMcpServer(
  value: unknown,
  previous: ManagedMcpServer | null,
  name: string,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const document = isRecord(value) ? { ...value } : {};
  const container: McpConfigContainer = previous?.container ?? "mcpServers";

  if (previous) {
    const previousMap = isRecord(document[previous.container])
      ? { ...(document[previous.container] as Record<string, unknown>) }
      : {};
    delete previousMap[previous.name];
    document[previous.container] = previousMap;
  }

  const target = isRecord(document[container])
    ? { ...(document[container] as Record<string, unknown>) }
    : {};
  target[name] = config;
  document[container] = target;
  return document;
}

export function removeManagedMcpServer(
  value: unknown,
  server: ManagedMcpServer,
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const document = { ...value };
  const container = isRecord(document[server.container])
    ? { ...(document[server.container] as Record<string, unknown>) }
    : {};
  delete container[server.name];

  if (Object.keys(container).length > 0) document[server.container] = container;
  else delete document[server.container];

  return Object.keys(document).length > 0 ? document : null;
}

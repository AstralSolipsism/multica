// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../../locales/en/common.json";
import enAgents from "../../../locales/en/agents.json";
import type { ManagedMcpServer } from "./mcp-config-model";
import { McpServerDialog } from "./mcp-server-dialog";

const TEST_RESOURCES = { en: { common: enCommon, agents: enAgents } };

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      {children}
    </I18nProvider>
  );
}

function managedServer(overrides: Partial<ManagedMcpServer> = {}): ManagedMcpServer {
  return {
    name: "fetch",
    config: { command: "uvx" },
    container: "mcpServers",
    transport: "stdio",
    enabled: true,
    ...overrides,
  };
}

function renderDialog(overrides: Partial<ComponentProps<typeof McpServerDialog>> = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onOpenChange = vi.fn();
  const props = {
    open: true,
    server: null,
    existingNames: new Set<string>(),
    onSave,
    onOpenChange,
    ...overrides,
  };
  const view = render(<McpServerDialog {...props} />, { wrapper: Wrapper });
  return { ...view, onSave: props.onSave, onOpenChange: props.onOpenChange };
}

describe("McpServerDialog", () => {
  it.each(["context7.dev", "legacy server", " padded "])(
    "edits configuration while preserving the historical name %s exactly",
    async (name) => {
      const user = userEvent.setup();
      const { onSave, onOpenChange } = renderDialog({
        server: managedServer({ name }),
        existingNames: new Set([name]),
        hideNameWhenEditing: true,
      });

      expect(screen.queryByLabelText("Server name")).toBeNull();
      await user.clear(screen.getByLabelText("Command"));
      await user.type(screen.getByLabelText("Command"), "updated-command");
      await user.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() =>
        expect(onSave).toHaveBeenCalledWith(name, { command: "updated-command" }),
      );
      expect(onOpenChange).toHaveBeenCalledWith(false);
    },
  );

  it.each(["create", "rename"])(
    "rejects a newly entered historical-style name during %s",
    async (action) => {
      const user = userEvent.setup();
      const { onSave, onOpenChange } = renderDialog({
        server: action === "rename" ? managedServer() : null,
      });

      const input = screen.getByLabelText("Server name");
      await user.clear(input);
      await user.type(input, "context7.dev");
      if (action === "create") {
        await user.type(screen.getByLabelText("Command"), "uvx");
      }
      await user.click(screen.getByRole("button", {
        name: action === "create" ? "Add" : "Save",
      }));

      expect(input).toHaveFocus();
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Use only letters, numbers, hyphens, and underscores.",
      );
      expect(onSave).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["sse", "STDIO", "Command", "uvx", { command: "uvx" }],
    ["websocket", "Streamable HTTP", "Server URL", "https://new.example/mcp", {
      type: "http", url: "https://new.example/mcp",
    }],
  ])(
    "replaces a %s server through the visual editor using %s",
    async (transport, selected, label, value, expected) => {
      const user = userEvent.setup();
      const { onSave } = renderDialog({
        server: managedServer({ transport, config: {} }),
        replacementMode: true,
      });

      expect(screen.getByRole("tab", { name: "JSON" })).toHaveAttribute(
        "aria-selected", "true",
      );
      await user.click(screen.getByRole("tab", { name: "Visual editor" }));
      await user.click(screen.getByRole("button", { name: new RegExp(`^${selected}`) }));
      await user.type(screen.getByLabelText(label), value);
      await user.click(screen.getByRole("button", { name: "Replace configuration" }));

      expect(onSave).toHaveBeenCalledWith("fetch", expected);
    },
  );

  it("blocks duplicate submits and dismissal until a save completes", async () => {
    const user = userEvent.setup();
    let finishSave!: () => void;
    const onSave = vi.fn(() => new Promise<void>((resolve) => { finishSave = resolve; }));
    const { onOpenChange } = renderDialog({ server: managedServer(), onSave });

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.submit(screen.getByLabelText("Command").closest("form")!);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onSave).toHaveBeenCalledExactlyOnceWith("fetch", { command: "uvx" });

    finishSave();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it.each(["Cancel", "Close", "Escape"])(
    "discards an unsaved draft when dismissed with %s",
    async (action) => {
      const user = userEvent.setup();
      const { onSave, onOpenChange } = renderDialog();
      await user.type(screen.getByLabelText("Server name"), "draft");

      if (action === "Escape") await user.keyboard("{Escape}");
      else await user.click(screen.getByRole("button", { name: action }));

      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(onSave).not.toHaveBeenCalled();
    },
  );

  it("clears submitted JSON errors when returning to the visual editor", async () => {
    const user = userEvent.setup();
    const { onSave } = renderDialog();
    await user.type(screen.getByLabelText("Server name"), "fetch");
    await user.type(screen.getByLabelText("Command"), "uvx");
    await user.click(screen.getByRole("tab", { name: "JSON" }));
    fireEvent.change(screen.getByLabelText("MCP server JSON configuration"), {
      target: { value: "{invalid" },
    });
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Invalid JSON");

    await user.click(screen.getByRole("tab", { name: "Visual editor" }));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("Command")).toHaveValue("uvx");
    expect(screen.getByLabelText("Command")).not.toHaveAttribute("aria-invalid");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(onSave).toHaveBeenCalledWith("fetch", { command: "uvx" });
  });

  it("removes one argument and environment row while preserving their siblings", async () => {
    const user = userEvent.setup();
    const { onSave } = renderDialog({
      server: managedServer({
        config: {
          command: "uvx",
          args: ["first", "remove", "last"],
          env: { FIRST: "one", REMOVE: "two", LAST: "three" },
        },
      }),
    });

    await user.click(screen.getByRole("button", { name: "Remove argument 2" }));
    await user.clear(screen.getByLabelText("Startup arguments 2"));
    await user.type(screen.getByLabelText("Startup arguments 2"), "updated-last");
    await user.click(screen.getByRole("button", { name: "Remove environment variable 2" }));
    await user.clear(screen.getByLabelText("Environment variables: Variable name 2"));
    await user.type(screen.getByLabelText("Environment variables: Variable name 2"), "UPDATED");
    await user.clear(screen.getByLabelText("Environment variables: Value 2"));
    await user.type(screen.getByLabelText("Environment variables: Value 2"), "four");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith("fetch", {
      command: "uvx",
      args: ["first", "updated-last"],
      env: { FIRST: "one", UPDATED: "four" },
    });
  });

  it("removes one HTTP header while preserving and editing its siblings", async () => {
    const user = userEvent.setup();
    const { onSave } = renderDialog({
      server: managedServer({
        transport: "http",
        config: {
          type: "http",
          url: "https://example.test/mcp",
          headers: { First: "one", Remove: "two", Last: "three" },
        },
      }),
    });

    await user.click(screen.getByRole("button", { name: "Remove header 2" }));
    await user.clear(screen.getByLabelText("HTTP headers: Header name 2"));
    await user.type(screen.getByLabelText("HTTP headers: Header name 2"), "Updated");
    await user.clear(screen.getByLabelText("HTTP headers: Value 2"));
    await user.type(screen.getByLabelText("HTTP headers: Value 2"), "four");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith("fetch", {
      type: "http",
      url: "https://example.test/mcp",
      headers: { First: "one", Updated: "four" },
    });
  });

  // The derivation/collision matrix itself is covered node-side in
  // mcp-config-model.test.ts; here only the wiring between it and the draft.
  it("suggests a unique name from the typed command until the user edits it", async () => {
    const user = userEvent.setup();
    renderDialog({ existingNames: new Set(["server-github"]) });

    const name = screen.getByLabelText("Server name");
    expect(name).toHaveValue("");

    await user.type(screen.getByLabelText("Command"), "npx");
    // A bare launcher has no meaningful name yet.
    expect(name).toHaveValue("");

    await user.click(screen.getByRole("button", { name: "Add argument" }));
    await user.type(screen.getByLabelText("Startup arguments 1"), "-y");
    await user.click(screen.getByRole("button", { name: "Add argument" }));
    await user.type(
      screen.getByLabelText("Startup arguments 2"),
      "@modelcontextprotocol/server-github",
    );
    expect(name).toHaveValue("server-github-2");

    // Once the user edits the name, command changes stop rewriting it.
    await user.clear(name);
    await user.type(name, "my-fetch");
    await user.clear(screen.getByLabelText("Command"));
    await user.type(screen.getByLabelText("Command"), "uvx");
    expect(name).toHaveValue("my-fetch");
  });

  it("suggests a name from the endpoint URL", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /^Streamable HTTP/ }));
    await user.type(
      screen.getByLabelText("Server URL"),
      "https://mcp.notion.com/mcp",
    );

    expect(screen.getByLabelText("Server name")).toHaveValue("notion");
  });

  it("never rewrites the saved name of an existing server", async () => {
    const user = userEvent.setup();
    renderDialog({ server: managedServer() });

    const name = screen.getByLabelText("Server name");
    expect(name).toHaveValue("fetch");
    await user.clear(screen.getByLabelText("Command"));
    await user.type(screen.getByLabelText("Command"), "npx");
    await user.click(screen.getByRole("button", { name: "Add argument" }));
    await user.type(screen.getByLabelText("Startup arguments 1"), "other-server");

    expect(name).toHaveValue("fetch");
  });

  it("fills fields and the name from a pasted mcpServers snippet", async () => {
    const user = userEvent.setup();
    const { onSave } = renderDialog();

    await user.click(screen.getByRole("button", { name: "Paste a config snippet" }));
    fireEvent.change(screen.getByLabelText("MCP config snippet"), {
      target: {
        value: JSON.stringify({
          mcpServers: {
            github: {
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-github"],
              env: { GITHUB_TOKEN: "secret" },
            },
          },
        }),
      },
    });
    await user.click(screen.getByRole("button", { name: "Fill in fields" }));

    expect(screen.getByLabelText("Server name")).toHaveValue("github");
    expect(screen.getByLabelText("Command")).toHaveValue("npx");
    expect(screen.getByLabelText("Startup arguments 1")).toHaveValue("-y");
    expect(screen.getByLabelText("Startup arguments 2")).toHaveValue(
      "@modelcontextprotocol/server-github",
    );
    expect(
      screen.getByLabelText("Environment variables: Variable name 1"),
    ).toHaveValue("GITHUB_TOKEN");

    // The snippet's name latches like a typed one: editing the command must
    // not replace it with a derived suggestion.
    await user.type(screen.getByLabelText("Command"), "-alt");
    expect(screen.getByLabelText("Server name")).toHaveValue("github");

    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(onSave).toHaveBeenCalledWith("github", {
      command: "npx-alt",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "secret" },
    });
  });

  it("splits a pasted launch command line and derives the name, without running it", async () => {
    const user = userEvent.setup();
    const { onSave } = renderDialog();

    await user.click(screen.getByRole("button", { name: "Paste a config snippet" }));
    fireEvent.change(screen.getByLabelText("MCP config snippet"), {
      target: { value: "npx -y @modelcontextprotocol/server-github" },
    });
    await user.click(screen.getByRole("button", { name: "Fill in fields" }));

    expect(screen.getByLabelText("Command")).toHaveValue("npx");
    expect(screen.getByLabelText("Startup arguments 1")).toHaveValue("-y");
    expect(screen.getByLabelText("Startup arguments 2")).toHaveValue(
      "@modelcontextprotocol/server-github",
    );
    expect(screen.getByLabelText("Server name")).toHaveValue("server-github");

    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(onSave).toHaveBeenCalledWith("server-github", {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
    });
  });

  it("keeps the snippet and every draft field when the snippet fails validation", async () => {
    const user = userEvent.setup();
    const { onSave } = renderDialog();

    await user.type(screen.getByLabelText("Server name"), "draft-name");
    await user.type(screen.getByLabelText("Command"), "uvx");
    await user.click(screen.getByRole("button", { name: "Paste a config snippet" }));
    const snippet = screen.getByLabelText("MCP config snippet");
    fireEvent.change(snippet, { target: { value: "{invalid" } });
    await user.click(screen.getByRole("button", { name: "Fill in fields" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "That JSON doesn't parse",
    );
    expect(snippet).toHaveValue("{invalid");
    expect(screen.getByLabelText("Server name")).toHaveValue("draft-name");
    expect(screen.getByLabelText("Command")).toHaveValue("uvx");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("rejects a snippet that defines more than one server", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Paste a config snippet" }));
    fireEvent.change(screen.getByLabelText("MCP config snippet"), {
      target: {
        value:
          '{"mcpServers": {"one": {"command": "a"}, "two": {"command": "b"}}}',
      },
    });
    await user.click(screen.getByRole("button", { name: "Fill in fields" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "more than one server (one, two)",
    );
    expect(screen.getByLabelText("Command")).toHaveValue("");
  });

  it("fills the JSON editor instead when the entry cannot use the form", async () => {
    const user = userEvent.setup();
    renderDialog({
      server: managedServer({
        container: "mcp",
        config: { type: "local", command: ["old"] },
      }),
    });

    expect(screen.getByRole("tab", { name: "JSON" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Paste a config snippet" }));
    fireEvent.change(screen.getByLabelText("MCP config snippet"), {
      target: { value: "npx new-server" },
    });
    await user.click(screen.getByRole("button", { name: "Fill in fields" }));

    const json = screen.getByLabelText("MCP server JSON configuration");
    expect(json).toHaveValue(
      JSON.stringify({ command: "npx", args: ["new-server"] }, null, 2),
    );
    expect(screen.getByRole("tab", { name: "JSON" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // The saved name is identity and is never touched.
    expect(screen.getByLabelText("Server name")).toHaveValue("fetch");
  });

  it.each([false, true])(
    "preserves a pasted SSE config verbatim on save (replacement=%s)",
    async (replacementMode) => {
      const user = userEvent.setup();
      const onSave = vi.fn().mockResolvedValue(undefined);
      renderDialog({
        server: replacementMode
          ? managedServer({ name: "events", transport: "sse", config: {} })
          : null,
        replacementMode,
        existingNames: new Set(replacementMode ? ["events"] : []),
        onSave,
      });

      const config = {
        type: "sse",
        url: "https://example.test/sse",
        headers: { Authorization: "Bearer example" },
      };
      await user.click(
        screen.getByRole("button", { name: "Paste a config snippet" }),
      );
      fireEvent.change(screen.getByLabelText("MCP config snippet"), {
        target: { value: JSON.stringify({ mcpServers: { events: config } }) },
      });
      await user.click(screen.getByRole("button", { name: "Fill in fields" }));

      // The form would rewrite the entry to type "http" on save, so the
      // snippet must land on the verbatim JSON editor instead.
      expect(screen.getByRole("tab", { name: "JSON" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await user.click(
        screen.getByRole("button", {
          name: replacementMode ? "Replace configuration" : "Add",
        }),
      );
      await waitFor(() => expect(onSave).toHaveBeenCalled());
      expect(onSave).toHaveBeenCalledWith("events", config);
    },
  );

  it("keeps the draft and reports an error for a null command", async () => {
    const user = userEvent.setup();
    const { onSave } = renderDialog();

    fireEvent.change(screen.getByLabelText("Server name"), {
      target: { value: "draft" },
    });
    fireEvent.change(screen.getByLabelText("Command"), {
      target: { value: "uvx" },
    });
    await user.click(
      screen.getByRole("button", { name: "Add environment variable" }),
    );
    fireEvent.change(
      screen.getByLabelText("Environment variables: Variable name 1"),
      { target: { value: "API_KEY" } },
    );
    fireEvent.change(
      screen.getByLabelText("Environment variables: Value 1"),
      { target: { value: "draft-secret" } },
    );
    await user.click(
      screen.getByRole("button", { name: "Paste a config snippet" }),
    );
    fireEvent.change(screen.getByLabelText("MCP config snippet"), {
      target: { value: '{"command":null}' },
    });
    await user.click(screen.getByRole("button", { name: "Fill in fields" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The snippet needs a command or a url.",
    );
    // Nothing was applied: the snippet stays put and every drafted field
    // keeps its value.
    expect(screen.getByLabelText("MCP config snippet")).toHaveValue(
      '{"command":null}',
    );
    expect(screen.getByLabelText("Command")).toHaveValue("uvx");
    expect(
      screen.getByLabelText("Environment variables: Value 1"),
    ).toHaveValue("draft-secret");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("rejects a command array whose executable element is empty, keeping the draft", async () => {
    const user = userEvent.setup();
    const { onSave } = renderDialog();

    fireEvent.change(screen.getByLabelText("Server name"), {
      target: { value: "draft" },
    });
    fireEvent.change(screen.getByLabelText("Command"), {
      target: { value: "uvx" },
    });
    await user.click(
      screen.getByRole("button", { name: "Add environment variable" }),
    );
    fireEvent.change(
      screen.getByLabelText("Environment variables: Value 1"),
      { target: { value: "draft-secret" } },
    );
    await user.click(
      screen.getByRole("button", { name: "Paste a config snippet" }),
    );
    fireEvent.change(screen.getByLabelText("MCP config snippet"), {
      target: { value: '{"command":["","--help"]}' },
    });
    await user.click(screen.getByRole("button", { name: "Fill in fields" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The snippet needs a command or a url.",
    );
    expect(screen.getByLabelText("MCP config snippet")).toHaveValue(
      '{"command":["","--help"]}',
    );
    expect(screen.getByLabelText("Command")).toHaveValue("uvx");
    expect(
      screen.getByLabelText("Environment variables: Value 1"),
    ).toHaveValue("draft-secret");
    expect(onSave).not.toHaveBeenCalled();
  });

  it.each(["", "old-server"])(
    "suggests a deduplicated name for an unnamed SSE snippet after command %j",
    async (previousCommand) => {
      const user = userEvent.setup();
      const onSave = vi.fn().mockResolvedValue(undefined);
      renderDialog({ existingNames: new Set(["notion"]), onSave });

      if (previousCommand !== "") {
        fireEvent.change(screen.getByLabelText("Command"), {
          target: { value: previousCommand },
        });
        expect(screen.getByLabelText("Server name")).toHaveValue("old-server");
      }
      const config = { type: "sse", url: "https://mcp.notion.com/sse" };
      await user.click(
        screen.getByRole("button", { name: "Paste a config snippet" }),
      );
      fireEvent.change(screen.getByLabelText("MCP config snippet"), {
        target: { value: JSON.stringify(config) },
      });
      await user.click(screen.getByRole("button", { name: "Fill in fields" }));

      // The snippet routes to the verbatim JSON editor, and the name is
      // derived from the snippet's own endpoint — not left empty, and not
      // the stale suggestion from the earlier draft.
      expect(screen.getByRole("tab", { name: "JSON" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(screen.getByLabelText("Server name")).toHaveValue("notion-2");
      await user.click(screen.getByRole("button", { name: "Add" }));
      expect(onSave).toHaveBeenCalledWith("notion-2", config);
    },
  );
});

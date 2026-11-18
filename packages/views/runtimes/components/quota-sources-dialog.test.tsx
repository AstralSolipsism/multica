// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setApiInstance, type QuotaSource } from "@multica/core/api";
import { ApiClient } from "@multica/core/api/client";
import { quotaSourceListOptions } from "@multica/core/runtimes";
import { renderWithI18n } from "../../test/i18n";
import {
  QuotaSourcesDialog,
  quotaSourceRefreshCooldownSeconds,
} from "./quota-sources-dialog";

afterEach(() => vi.unstubAllGlobals());

const NOW = Date.now();
const source: QuotaSource = {
  id: "source-1",
  kind: "glm",
  name: "Primary GLM",
  base_url: "https://open.bigmodel.cn",
  credential_hint: "a3f9",
  enabled: true,
  visibility: "private",
  quota: null,
  last_polled_at: new Date(NOW - 60_000).toISOString(),
  last_error: null,
  created_at: new Date(NOW - 120_000).toISOString(),
  updated_at: new Date(NOW - 120_000).toISOString(),
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function setup(
  sources: QuotaSource[] | null = [source],
  fetcher = vi.fn(),
) {
  vi.stubGlobal("fetch", fetcher);
  setApiInstance(new ApiClient("https://example.test"));
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  if (sources) {
    qc.setQueryData(quotaSourceListOptions().queryKey, {
      encryption_configured: true,
      sources,
    });
  }
  const user = userEvent.setup();
  renderWithI18n(
    <QueryClientProvider client={qc}>
      <QuotaSourcesDialog open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
  return { qc, user, fetcher };
}

async function fillNewSource(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/^Name/), "ZenMux Pro");
  await user.click(screen.getByRole("button", { name: /ZenMux/ }));
  await user.type(screen.getByLabelText("Management API Key"), "zenmux-secret-key");
  await user.click(screen.getByRole("radio", { name: /Shared/ }));
}

describe("QuotaSourcesDialog", () => {
  it("opens the empty state and creates a ZenMux source with only the finalized fields", async () => {
    const created = {
      ...source,
      id: "created-1",
      kind: "zenmux",
      name: "ZenMux Pro",
      visibility: "shared",
      credential_hint: "-key",
    };
    const fetcher = vi.fn().mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve(jsonResponse(created, 201));
      return Promise.resolve(jsonResponse({ encryption_configured: true, sources: [created] }));
    });
    const { user } = setup([], fetcher);

    await user.click(screen.getByRole("button", { name: "Add source" }));
    expect(screen.getByRole("button", { name: /Zhipu GLM Coding Plan/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ZenMux/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /DeepSeek API balance/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /OpenCode account/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /OpenCode Jev free channel/ })).toBeInTheDocument();
    expect(screen.queryByText(/Generic HTTP/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Binding target|Mount target/)).not.toBeInTheDocument();

    await fillNewSource(user);
    await user.click(screen.getByRole("button", { name: "Save and verify" }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/api/me/quota-sources"),
      expect.objectContaining({ method: "POST" }),
    ));
    const post = fetcher.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    // An empty base_url is omitted on create: the server defaults it, and
    // re-sending "unchanged" values must never trigger a re-probe.
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
      kind: "zenmux",
      name: "ZenMux Pro",
      credential: "zenmux-secret-key",
      visibility: "shared",
    });
    expect(await screen.findByText("ZenMux Pro")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save and verify" })).not.toBeInTheDocument();
  });

  it("creates a jev_free monitor without any credential input", async () => {
    const created = {
      ...source,
      id: "created-free",
      kind: "jev_free",
      name: "免费通道",
      credential_hint: "",
    };
    const fetcher = vi.fn().mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve(jsonResponse(created, 201));
      return Promise.resolve(jsonResponse({ encryption_configured: true, sources: [created] }));
    });
    const { user } = setup([], fetcher);

    await user.click(screen.getByRole("button", { name: "Add source" }));
    await user.type(screen.getByLabelText(/^Name/), "免费通道");
    await user.click(screen.getByRole("button", { name: /OpenCode Jev free channel/ }));
    // Credential-free kind: no API key input at all.
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
    expect(screen.getByText(/needs no API key/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save and verify" }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/api/me/quota-sources"),
      expect.objectContaining({ method: "POST" }),
    ));
    const post = fetcher.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
      kind: "jev_free",
      name: "免费通道",
      credential: "",
      visibility: "private",
    });
  });

  it.each([
    {
      status: 422,
      body: { code: "quota_source_probe_failed", reason: "invalid_credential", message: "401" },
      expected: "The provider rejected this credential",
    },
    {
      status: 503,
      body: { code: "quota_source_encryption_unconfigured", message: "not configured" },
      expected: "MULTICA_QUOTA_SOURCE_SECRET_KEY",
    },
  ])("keeps the draft and shows a specific $status failure in the form", async ({ status, body, expected }) => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(body, status));
    const { user } = setup([], fetcher);

    await user.click(screen.getByRole("button", { name: "Add source" }));
    await user.type(screen.getByLabelText(/^Name/), "Primary GLM");
    await user.type(screen.getByLabelText("API Key"), "original-secret");
    await user.click(screen.getByRole("button", { name: "Save and verify" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(expected);
    expect(screen.getByLabelText(/^Name/)).toHaveValue("Primary GLM");
    expect(screen.getByLabelText("API Key")).toHaveValue("original-secret");
    expect(screen.getByRole("button", { name: "Save and verify" })).toBeInTheDocument();
  });

  it("shows only a masked saved credential and reveals the input after Replace key", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Edit Primary GLM" }));

    const masked = screen.getByLabelText("Saved credential (masked)");
    expect(masked).toHaveValue("•••• •••• •••• a3f9");
    expect(masked).toHaveAttribute("readonly");
    expect(screen.queryByDisplayValue(/actual-secret/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Replace key" }));
    expect(screen.getByLabelText("API Key")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("API Key")).toHaveValue("");
  });

  it("sends an enable/disable patch from the row switch", async () => {
    const fetcher = vi.fn().mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return Promise.resolve(jsonResponse({ ...source, enabled: false }));
      return Promise.resolve(jsonResponse({
        encryption_configured: true,
        sources: [{ ...source, enabled: false }],
      }));
    });
    const { user } = setup([source], fetcher);

    await user.click(screen.getByRole("switch", { name: "Toggle Primary GLM" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/api/me/quota-sources/source-1"),
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ enabled: false }) }),
    ));
  });

  it("enforces and explains the 30-second refresh cooldown", async () => {
    const recent = { ...source, last_polled_at: new Date(Date.now() - 10_000).toISOString() };
    const { user: _user } = setup([recent]);
    const now = Date.now();

    expect(quotaSourceRefreshCooldownSeconds(recent, now)).toBe(20);
    expect(screen.getByRole("button", { name: "Refresh Primary GLM" })).toBeDisabled();
    expect(screen.getByText(/Refresh available in \d+s/)).toBeInTheDocument();
  });

  it("refreshes an eligible source through the refresh endpoint", async () => {
    const fetcher = vi.fn().mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve(jsonResponse(source));
      return Promise.resolve(jsonResponse({ encryption_configured: true, sources: [source] }));
    });
    const { user } = setup([source], fetcher);

    await user.click(screen.getByRole("button", { name: "Refresh Primary GLM" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/api/me/quota-sources/source-1/refresh"),
      expect.objectContaining({ method: "POST" }),
    ));
  });

  it("requires confirmation before deleting a source", async () => {
    const fetcher = vi.fn().mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(jsonResponse({ encryption_configured: true, sources: [] }));
    });
    const { user } = setup([source], fetcher);

    await user.click(screen.getByRole("button", { name: "Delete Primary GLM" }));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Delete monitor" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/api/me/quota-sources/source-1"),
      expect.objectContaining({ method: "DELETE" }),
    ));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("offers retry when the list fails to load", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ error: "unavailable" }, 500));
    const { user } = setup(null, fetcher);

    expect(await screen.findByText("Couldn't load quota sources.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });

  it("defaults a new OpenCode source to pay-as-you-go and swaps the credential field with the query type", async () => {
    const created = {
      ...source,
      id: "created-oc",
      kind: "opencode",
      name: "OpenCode",
      opencode_mode: "payg" as const,
      workspace_id: "wrk_abc",
      credential_hint: "xyz9",
    };
    const fetcher = vi.fn().mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve(jsonResponse(created, 201));
      return Promise.resolve(jsonResponse({ encryption_configured: true, sources: [created] }));
    });
    const { user } = setup([], fetcher);

    await user.click(screen.getByRole("button", { name: "Add source" }));
    await user.click(screen.getByRole("button", { name: /OpenCode account/ }));

    // Default mode: pay-as-you-go balance.
    expect(screen.getByRole("radio", { name: /Pay-as-you-go balance/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Go subscription quota/ })).not.toBeChecked();
    expect(screen.getByLabelText("Session Cookie")).toBeInTheDocument();
    expect(screen.getByLabelText("Workspace ID (optional)")).toBeInTheDocument();
    expect(screen.queryByLabelText("Zen API Key")).not.toBeInTheDocument();

    // Switching to Go swaps Cookie/workspace for the Zen API key.
    await user.click(screen.getByRole("radio", { name: /Go subscription quota/ }));
    expect(screen.getByLabelText("Zen API Key")).toBeInTheDocument();
    expect(screen.queryByLabelText("Session Cookie")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Workspace ID (optional)")).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /Pay-as-you-go balance/ }));
    await user.type(screen.getByLabelText("Session Cookie"), "__Host-console_session=cookie-xyz");
    await user.type(screen.getByLabelText("Workspace ID (optional)"), "wrk_abc");
    await user.click(screen.getByRole("button", { name: "Save and verify" }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/api/me/quota-sources"),
      expect.objectContaining({ method: "POST" }),
    ));
    const post = fetcher.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
      kind: "opencode",
      name: "OpenCode",
      credential: "__Host-console_session=cookie-xyz",
      visibility: "private",
      opencode_mode: "payg",
      workspace_id: "wrk_abc",
    });
  });

  it("reveals field guidance only when the OpenCode help icon is hovered", async () => {
    const { user } = setup([], vi.fn());
    await user.click(screen.getByRole("button", { name: "Add source" }));
    await user.click(screen.getByRole("button", { name: /OpenCode account/ }));

    expect(screen.queryByText(/Sign in at https:\/\/opencode\.ai/)).not.toBeInTheDocument();
    await user.hover(screen.getByRole("button", { name: "How to get Session Cookie" }));
    expect(await screen.findByText(/Sign in at https:\/\/opencode\.ai/)).toBeInTheDocument();

    await user.hover(screen.getByRole("button", { name: "How to get Workspace ID (optional)" }));
    expect(await screen.findByText(/default workspace/)).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /Go subscription quota/ }));
    await user.hover(screen.getByRole("button", { name: "How to get Zen API Key" }));
    expect(await screen.findByText(/API Keys section/)).toBeInTheDocument();
  });

  it("creates an OpenCode Go source with the Zen API key and no workspace field", async () => {
    const created = {
      ...source,
      id: "created-oc-go",
      kind: "opencode",
      name: "OpenCode",
      opencode_mode: "go" as const,
    };
    const fetcher = vi.fn().mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve(jsonResponse(created, 201));
      return Promise.resolve(jsonResponse({ encryption_configured: true, sources: [created] }));
    });
    const { user } = setup([], fetcher);

    await user.click(screen.getByRole("button", { name: "Add source" }));
    await user.click(screen.getByRole("button", { name: /OpenCode account/ }));
    await user.click(screen.getByRole("radio", { name: /Go subscription quota/ }));
    await user.type(screen.getByLabelText("Zen API Key"), "sk-zen-123456");
    await user.click(screen.getByRole("button", { name: "Save and verify" }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/api/me/quota-sources"),
      expect.objectContaining({ method: "POST" }),
    ));
    const post = fetcher.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
      kind: "opencode",
      name: "OpenCode",
      credential: "sk-zen-123456",
      visibility: "private",
      opencode_mode: "go",
    });
  });

  it("falls back to the channel's short default name when the optional name is left blank", async () => {
    const created = { ...source, id: "created-ds", kind: "deepseek", name: "DeepSeek" };
    const fetcher = vi.fn().mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve(jsonResponse(created, 201));
      return Promise.resolve(jsonResponse({ encryption_configured: true, sources: [created] }));
    });
    const { user } = setup([], fetcher);

    await user.click(screen.getByRole("button", { name: "Add source" }));
    await user.click(screen.getByRole("button", { name: /DeepSeek API balance/ }));
    // No name typed.
    await user.type(screen.getByLabelText("API Key"), "sk-deepseek-123456");
    await user.click(screen.getByRole("button", { name: "Save and verify" }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/api/me/quota-sources"),
      expect.objectContaining({ method: "POST" }),
    ));
    const post = fetcher.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
      kind: "deepseek",
      name: "DeepSeek",
      credential: "sk-deepseek-123456",
      visibility: "private",
    });
  });

  it("edits a legacy OpenCode API-key source in Go mode and requires a Cookie after switching", async () => {
    const legacy: QuotaSource = {
      ...source,
      id: "source-legacy-oc",
      kind: "opencode",
      name: "OpenCode",
      credential_hint: "3f9a",
    };
    const { user } = setup([legacy]);
    await user.click(screen.getByRole("button", { name: "Edit OpenCode" }));

    // Legacy rows carry no mode; they stay in the historical Go mode.
    expect(screen.getByRole("radio", { name: /Go subscription quota/ })).toBeChecked();
    expect(screen.getByLabelText("Saved credential (masked)")).toHaveValue("•••• •••• •••• 3f9a");

    await user.click(screen.getByRole("radio", { name: /Pay-as-you-go balance/ }));
    // The two modes use different secrets: the Cookie input opens empty.
    expect(screen.getByLabelText("Session Cookie")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Session Cookie")).toHaveValue("");
  });
});

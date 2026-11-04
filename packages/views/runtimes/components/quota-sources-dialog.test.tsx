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
  await user.type(screen.getByLabelText("Name"), "ZenMux Pro");
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

    await user.click(screen.getByRole("button", { name: "Add subscription" }));
    expect(screen.getByRole("button", { name: /Zhipu GLM Coding Plan/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ZenMux/ })).toBeInTheDocument();
    expect(screen.queryByText(/Generic HTTP/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Binding target|Mount target/)).not.toBeInTheDocument();

    await fillNewSource(user);
    await user.click(screen.getByRole("button", { name: "Save and verify" }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/api/me/quota-sources"),
      expect.objectContaining({ method: "POST" }),
    ));
    const post = fetcher.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
      kind: "zenmux",
      name: "ZenMux Pro",
      credential: "zenmux-secret-key",
      base_url: "",
      visibility: "shared",
    });
    expect(await screen.findByText("ZenMux Pro")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save and verify" })).not.toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: "Add subscription" }));
    await user.type(screen.getByLabelText("Name"), "Primary GLM");
    await user.type(screen.getByLabelText("API Key"), "original-secret");
    await user.click(screen.getByRole("button", { name: "Save and verify" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(expected);
    expect(screen.getByLabelText("Name")).toHaveValue("Primary GLM");
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

    await user.click(screen.getByRole("button", { name: "Delete subscription" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/api/me/quota-sources/source-1"),
      expect.objectContaining({ method: "DELETE" }),
    ));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("offers retry when the list fails to load", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ error: "unavailable" }, 500));
    const { user } = setup(null, fetcher);

    expect(await screen.findByText("Couldn't load subscription quotas.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });
});

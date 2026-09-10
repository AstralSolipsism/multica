// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@multica/core/api";
import type { MessageEventCatalog } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider } from "../../navigation";

import { TeamSubscriptionsSection } from "./team-subscriptions-section";

const NAV_ADAPTER = {
  push: () => {},
  replace: () => {},
  back: () => {},
  pathname: "/ws/settings",
  searchParams: new URLSearchParams(),
  hash: "",
  getShareableUrl: (path: string) => path,
};

type QueryResult = {
  data?: unknown;
  isLoading: boolean;
  isError: boolean;
  isSuccess: boolean;
  error?: unknown;
};

const ok = vi.hoisted(
  () =>
    (data: unknown): QueryResult => ({
      data,
      isLoading: false,
      isError: false,
      isSuccess: true,
    }),
);

const routesRef = vi.hoisted(() => ({ current: ok([]) as QueryResult }));
const catalogRef = vi.hoisted(() => ({ current: ok(undefined) as QueryResult }));
const approvalsRef = vi.hoisted(() => ({ current: ok([]) as QueryResult }));
const projectsRef = vi.hoisted(() => ({ current: ok([]) as QueryResult }));
const DEFAULT_INSTALLATIONS = {
  installations: [{ id: "inst-1", agent_id: "agent-1", status: "active", region: "feishu" }],
  configured: true,
};
const installationsRef = vi.hoisted(() => ({
  current: undefined as unknown as QueryResult,
}));
const roleRef = vi.hoisted(() => ({ current: "owner" as string | null }));
const roleLoadingRef = vi.hoisted(() => ({ current: false }));
// Every requested query key, so the non-admin gate can be verified by the
// absence of admin-gated requests — not just by what's rendered.
const requestedKeys = vi.hoisted(() => ({ current: [] as string[] }));

const mockCreate = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockApprove = vi.hoisted(() => vi.fn());
const mockRevoke = vi.hoisted(() => vi.fn());
const mockSetEnabled = vi.hoisted(() => vi.fn());
const mockDelete = vi.hoisted(() => vi.fn());
const mockTestSend = vi.hoisted(() => vi.fn());
const mockRetry = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey: unknown[]; enabled?: boolean }) => {
    const key = JSON.stringify(opts.queryKey);
    requestedKeys.current.push(key);
    if (opts.enabled === false) {
      return { data: undefined, isLoading: false, isError: false, isSuccess: false };
    }
    if (key.includes("approved-targets")) return approvalsRef.current;
    if (key.includes("catalog")) return catalogRef.current;
    if (key.includes("routes")) return routesRef.current;
    if (key.includes("installations")) return installationsRef.current;
    if (key.includes("projects")) return projectsRef.current;
    return { data: undefined, isLoading: false, isError: false, isSuccess: false };
  },
  useInfiniteQuery: () => ({
    data: { pages: [{ deliveries: [], limit: 100, offset: 0 }] },
    isLoading: false,
    isError: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    isFetchingNextPage: false,
  }),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
    fetchQuery: async () => ({ routes: routesRef.current.data ?? [] }),
  }),
  queryOptions: <T,>(opts: T) => opts,
  infiniteQueryOptions: <T,>(opts: T) => opts,
}));

vi.mock("@multica/core/message-delivery", () => ({
  messageSourceRoutesOptions: (_wsId: string, sourceKind?: string) => ({
    queryKey: ["message-sources", "ws-1", "routes", sourceKind ?? "all"],
  }),
  messageEventCatalogOptions: (_wsId: string) => ({
    queryKey: ["message-sources", "ws-1", "catalog"],
  }),
  messageSourceApprovedTargetsOptions: (_wsId: string, options?: { enabled?: boolean }) => ({
    queryKey: ["message-sources", "ws-1", "approved-targets"],
    enabled: options?.enabled ?? true,
  }),
  messageRouteDeliveriesInfiniteOptions: (
    _wsId: string,
    routeId: string,
    scope?: { status?: string },
  ) => ({
    queryKey: ["message-sources", "ws-1", "deliveries", routeId, scope?.status ?? "all"],
  }),
  messageRouteDeliveryOptions: (_wsId: string, routeId: string, deliveryId: string) => ({
    queryKey: ["message-sources", "ws-1", "deliveries", routeId, "detail", deliveryId],
  }),
  messageSourceKeys: {
    delivery: (wsId: string, routeId: string, deliveryId: string) => [
      "message-sources",
      wsId,
      "deliveries",
      routeId,
      "detail",
      deliveryId,
    ],
  },
  useCreateMessageSourceRoute: () => ({ mutateAsync: mockCreate, isPending: false }),
  useUpdateMessageSourceRoute: () => ({ mutateAsync: mockUpdate, isPending: false }),
  useApproveMessageSourceTarget: () => ({ mutateAsync: mockApprove, isPending: false }),
  useRevokeMessageSourceTarget: () => ({ mutate: mockRevoke, isPending: false }),
  useSetMessageSourceRouteEnabled: () => ({ mutate: mockSetEnabled, isPending: false }),
  useDeleteMessageSourceRoute: () => ({ mutate: mockDelete, isPending: false }),
  useTestMessageSourceRoute: () => ({ mutate: mockTestSend, isPending: false }),
  useRetryMessageRouteDelivery: () => ({ mutate: mockRetry, isPending: false }),
}));

vi.mock("@multica/core/lark", () => ({
  larkInstallationsOptions: (wsId: string) => ({
    queryKey: ["lark", wsId, "installations"],
  }),
}));

vi.mock("@multica/core/projects/queries", () => ({
  projectListOptions: () => ({ queryKey: ["projects"] }),
}));

vi.mock("@multica/core/workspace/queries", () => ({
  memberListOptions: () => ({ queryKey: ["members"] }),
}));

vi.mock("@multica/core/permissions", () => ({
  useCurrentMember: () => ({ role: roleRef.current, isLoading: roleLoadingRef.current }),
}));

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: (_t: string, id: string) => `Agent ${id}` }),
}));

vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({
    settings: () => "/ws/settings",
    issueDetail: (id: string) => `/ws/issues/${id}`,
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError, warning: vi.fn() },
}));

const CATALOG: MessageEventCatalog = {
  personal: { source_kind: "inbox", target_type: "member", event_types: [] },
  team: [
    {
      source_kind: "activity",
      events: [{ event: "status_changed", label: "Issue status changed" }],
    },
  ],
};

const PROJECTS = [{ id: "p1", title: "Alpha" }];


function renderSection() {
  return renderWithI18n(
    <NavigationProvider value={NAV_ADAPTER}>
      <TeamSubscriptionsSection />
    </NavigationProvider>,
  );
}

describe("OL-28 review: source settings request failures", () => {
  beforeEach(() => {
    routesRef.current = ok([]);
    catalogRef.current = ok(CATALOG);
    approvalsRef.current = ok([]);
    projectsRef.current = ok(PROJECTS);
    installationsRef.current = ok(DEFAULT_INSTALLATIONS);
    roleRef.current = "owner";
    roleLoadingRef.current = false;
    requestedKeys.current = [];
    mockCreate.mockReset().mockResolvedValue({});
    mockUpdate.mockReset().mockResolvedValue({});
    mockApprove.mockReset().mockResolvedValue({});
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  afterEach(cleanup);

  it.each([403, 500])("does not label a failed approvals request (%s) as a confirmed empty list", (status) => {
    approvalsRef.current = {
      data: undefined,
      isLoading: false,
      isError: true,
      isSuccess: false,
      error: new ApiError("approvals unavailable", status, "request failed"),
    };
    renderSection();
    expect(screen.queryByText("No approved team targets yet.")).not.toBeInTheDocument();
  });

  it("blocks saving an unfiltered new route while the event catalog request failed", async () => {
    catalogRef.current = {
      data: undefined,
      isLoading: false,
      isError: true,
      isSuccess: false,
      error: new ApiError("catalog unavailable", 500, "Internal Server Error"),
    };
    renderSection();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add subscription" }));
    await user.type(screen.getByPlaceholderText("oc_..."), "oc_example");
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByRole("button", { name: /approve.*save|save.*approve/i })).toBeDisabled();
  });
});

// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enSquads from "../../locales/en/squads.json";

const TEST_RESOURCES = { en: { common: enCommon, squads: enSquads } };

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({
    squadDetail: (id: string) => `/test/squads/${id}`,
    agentDetail: (id: string) => `/test/agents/${id}`,
    memberDetail: (id: string) => `/test/members/${id}`,
  }),
}));

vi.mock("@multica/core/api", () => ({
  api: {
    getBaseUrl: () => "http://127.0.0.1:8080",
  },
}));

vi.mock("../../navigation", () => ({
  AppLink: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [k: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const mockSquads = vi.hoisted(() => ({ current: [] as unknown[] }));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query",
  );
  return {
    ...actual,
    useQuery: (opts: { queryKey: readonly unknown[] }) => {
      const key = opts.queryKey;
      if (key[0] === "workspaces" && key[2] === "squads") {
        return { data: mockSquads.current, isLoading: false };
      }
      return { data: [], isLoading: false };
    },
  };
});

import { SquadProfileCard } from "./squad-profile-card";

function makeSquad(overrides: Record<string, unknown> = {}) {
  return {
    id: "squad-1",
    name: "Core",
    description: null,
    avatar_url: null,
    leader_id: null,
    archived_at: null,
    member_preview: [],
    member_count: 0,
    ...overrides,
  };
}

function renderCard() {
  return render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <SquadProfileCard squadId="squad-1" />
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
  mockSquads.current = [makeSquad()];
});

// Regression (OL-1156): the squad hover card passed the raw avatar_url to the
// avatar, so a site-relative /api/avatars/... path rendered as a broken image
// on desktop or any deployment without MULTICA_PUBLIC_URL. The card must wrap
// it in resolvePublicFileUrl like AgentProfileCard and SquadsPage do.
describe("SquadProfileCard — avatar URL", () => {
  it("resolves a site-relative avatar_url against the API base URL", () => {
    mockSquads.current = [
      makeSquad({ avatar_url: "/api/avatars/sig/s.png" }),
    ];
    const { container } = renderCard();

    const img = container.querySelector<HTMLImageElement>(
      "[data-slot='avatar'] img",
    );
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe(
      "http://127.0.0.1:8080/api/avatars/sig/s.png",
    );
  });

  it("passes an absolute avatar_url through unchanged", () => {
    mockSquads.current = [
      makeSquad({ avatar_url: "https://cdn.example.com/s.png" }),
    ];
    const { container } = renderCard();

    const img = container.querySelector<HTMLImageElement>(
      "[data-slot='avatar'] img",
    );
    expect(img?.getAttribute("src")).toBe("https://cdn.example.com/s.png");
  });
});

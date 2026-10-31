import { render, screen } from "@testing-library/react";
import {
  createMemoryRouter,
  matchRoutes,
  RouterProvider,
} from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { appRoutes } from "./routes";
import { ProjectEngineeringPage } from "./pages/project-engineering-page";

vi.mock("@multica/views/projects/components", () => ({
  ProjectsPage: () => null,
  ProjectDetail: () => null,
  EngineeringOverview: ({
    workspaceSlug,
    projectId,
  }: {
    workspaceSlug: string;
    projectId: string;
  }) => <div data-testid="engineering-overview">{workspaceSlug}/{projectId}</div>,
}));

describe("project engineering route", () => {
  it("is registered below the workspace project routes", () => {
    const matches = matchRoutes(
      appRoutes,
      "/acme/projects/p1/engineering?candidate=rev-1",
    );

    expect(matches?.at(-1)?.route.path).toBe("projects/:id/engineering");
    expect(matches?.at(-1)?.params).toMatchObject({
      workspaceSlug: "acme",
      id: "p1",
    });
  });

  it("passes the routed workspace slug and project id to the shared view", () => {
    const router = createMemoryRouter(
      [{ path: "/:workspaceSlug/projects/:id/engineering", element: <ProjectEngineeringPage /> }],
      { initialEntries: ["/acme/projects/p1/engineering?candidate=rev-1"] },
    );

    render(<RouterProvider router={router} />);

    expect(screen.getByTestId("engineering-overview")).toHaveTextContent("acme/p1");
  });
});

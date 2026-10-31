"use client";

import { use } from "react";
import { EngineeringOverview } from "@multica/views/projects/components";

export default function ProjectEngineeringPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string; id: string }>;
}) {
  const { workspaceSlug, id } = use(params);
  return <EngineeringOverview workspaceSlug={workspaceSlug} projectId={id} />;
}

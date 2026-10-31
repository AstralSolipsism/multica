import { useParams } from "react-router-dom";
import { EngineeringOverview } from "@multica/views/projects/components";

export function ProjectEngineeringPage() {
  const { workspaceSlug, id } = useParams<{
    workspaceSlug: string;
    id: string;
  }>();

  if (!workspaceSlug || !id) return null;
  return <EngineeringOverview workspaceSlug={workspaceSlug} projectId={id} />;
}

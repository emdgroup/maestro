import { EnhancedRecentProject } from "../types/bindings";
import { Folder } from "lucide-react";
import { ProjectListItem } from "./ProjectListItem";
import { ProjectsListLayout } from "./ProjectsListLayout";

interface LocalProjectsListProps {
  recentProjects: EnhancedRecentProject[];
  onProjectClick: (path: string) => void;
  onSelectNewClick: () => void;
  onBack: () => void;
  onRemoveProject?: (path: string) => void;
  loading?: boolean;
}

export function LocalProjectsList({
  recentProjects,
  onProjectClick,
  onSelectNewClick,
  onBack,
  onRemoveProject,
  loading = false,
}: LocalProjectsListProps) {
  // Filter to only show local projects
  const localProjects = recentProjects.filter((p) => !p.is_remote);

  return (
    <ProjectsListLayout
      headerContent={
        <>
          <Folder className="w-5 h-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Local</h2>
        </>
      }
      isEmpty={localProjects.length === 0}
      emptyMessage="No recent local projects"
      onBack={onBack}
      onSelectNewClick={onSelectNewClick}
      loading={loading}
    >
      {localProjects.map((project) => (
        <ProjectListItem
          key={project.path}
          path={project.path}
          onClick={() => onProjectClick(project.path)}
          onRemove={onRemoveProject ? () => onRemoveProject(project.path) : undefined}
          disabled={loading}
        />
      ))}
    </ProjectsListLayout>
  );
}

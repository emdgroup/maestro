import { Folder } from "lucide-react";
import { ProjectListItem } from "./ProjectListItem";
import { ProjectsListLayout } from "./ProjectsListLayout";
import { useRecentProjects } from "@/hooks/useRecentProjects.ts";

interface LocalProjectsListProps {
  onProjectClick: (projectId: number) => void;
  onRemoveProject: (projectId: number) => void;
  onSelectNewClick: () => void;
  onBack: () => void;
}

export function LocalProjectsList({
  onProjectClick,
  onSelectNewClick,
  onBack,
  onRemoveProject,
}: LocalProjectsListProps) {
  const { recentProjects, loading } = useRecentProjects(null);

  return (
    <ProjectsListLayout
      headerContent={
        <>
          <Folder className="w-5 h-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Local</h2>
        </>
      }
      isEmpty={recentProjects.length === 0}
      emptyMessage="No recent local projects"
      onBack={onBack}
      onSelectNewClick={onSelectNewClick}
      loading={loading}
    >
      {recentProjects.map((project) => (
        <ProjectListItem
          key={project.id}
          path={project.path}
          onClick={() => onProjectClick(project.id)}
          onRemove={() => onRemoveProject(project.id)}
          disabled={loading}
        />
      ))}
    </ProjectsListLayout>
  );
}

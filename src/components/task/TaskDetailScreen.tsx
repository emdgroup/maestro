interface TaskDetailScreenProps {
  taskId: number;
}

export const TaskDetailScreen: React.FC<TaskDetailScreenProps> = ({ taskId }) => {
  return <div>Task #{taskId}</div>;
};

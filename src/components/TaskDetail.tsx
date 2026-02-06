import { useState } from 'react';
import { Task } from '../types/bindings';
import { ExecutionHistory } from './ExecutionHistory';
import { TerminalComponent } from './Terminal';
import '../styles/TaskDetail.css';

interface TaskDetailProps {
  task: Task | null;
  projectPath: string;
  onClose: () => void;
}

export function TaskDetail({ task, projectPath, onClose }: TaskDetailProps) {
  const [activeTab, setActiveTab] = useState<'info' | 'execution' | 'terminal'>('info');

  if (!task) return null;

  const showExecutionTab = ['InProgress', 'Review', 'Done'].includes(task.status);

  return (
    <div className="task-detail-modal" onClick={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="task-detail-content">
        <div className="task-detail-header">
          <h2>{task.name}</h2>
          <button className="close-button" onClick={onClose}>✕</button>
        </div>

        <div className="task-detail-tabs">
          <button
            className={`tab-button ${activeTab === 'info' ? 'active' : ''}`}
            onClick={() => setActiveTab('info')}
          >
            Details
          </button>
          {showExecutionTab && (
            <>
              <button
                className={`tab-button ${activeTab === 'execution' ? 'active' : ''}`}
                onClick={() => setActiveTab('execution')}
              >
                Execution
              </button>
              <button
                className={`tab-button ${activeTab === 'terminal' ? 'active' : ''}`}
                onClick={() => setActiveTab('terminal')}
              >
                Terminal
              </button>
            </>
          )}
        </div>

        <div className="task-detail-body">
          {activeTab === 'info' && (
            <div className="task-info">
              <div className="info-section">
                <h3>Description</h3>
                <p>{task.description || 'No description'}</p>
              </div>

              <div className="info-section">
                <h3>Acceptance Criteria</h3>
                <p>{task.acceptance_criteria || 'No criteria'}</p>
              </div>

              {task.skills && task.skills.length > 0 && (
                <div className="info-section">
                  <h3>Skills</h3>
                  <div className="skills-list">
                    {task.skills.map((skill) => (
                      <span key={skill} className="skill-badge">{skill}</span>
                    ))}
                  </div>
                </div>
              )}

              <div className="info-section">
                <h3>Status</h3>
                <p className={`status-badge status-${task.status}`}>{task.status}</p>
              </div>
            </div>
          )}

          {activeTab === 'execution' && (
            <ExecutionHistory
              taskId={task.id}
              projectId={task.project_id}
              projectPath={projectPath}
            />
          )}

          {activeTab === 'terminal' && (
            <div style={{ flex: 1, display: 'flex', height: '100%', overflow: 'hidden' }}>
              <TerminalComponent taskId={task.id} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

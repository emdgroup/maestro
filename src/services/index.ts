/**
 * Centralized service layer for all backend communication.
 * All services use the IPC wrapper for consistent error handling and logging.
 */

export { ipc } from "./ipc";
export { taskService } from "./task.service";
export { settingsService } from "./settings.service";
export { executionService } from "./execution.service";

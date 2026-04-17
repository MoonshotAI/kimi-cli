/**
 * Background task management tools barrel (Slice 3.5).
 */

export { BackgroundProcessManager, generateTaskId } from './manager.js';
export type {
  BackgroundTaskInfo,
  BackgroundTaskKind,
  BackgroundTaskStatus,
  ReconcileResult,
} from './manager.js';
export { VALID_TASK_ID } from './persist.js';
export { TaskListTool, TaskListInputSchema } from './task-list.js';
export type { TaskListInput } from './task-list.js';
export { TaskOutputTool, TaskOutputInputSchema } from './task-output.js';
export type { TaskOutputInput } from './task-output.js';
export { TaskStopTool, TaskStopInputSchema } from './task-stop.js';
export type { TaskStopInput } from './task-stop.js';

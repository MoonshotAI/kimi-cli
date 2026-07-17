/**
 * Background barrel export — corresponds to Python background/__init__.py
 */

export { generateTaskId } from "./ids.ts";
export { BackgroundTaskManager } from "./manager.ts";
export {
	type TaskConsumerState,
	type TaskControl,
	type TaskKind,
	type TaskOutputChunk,
	type TaskRuntime,
	type TaskSpec,
	type TaskStatus,
	type TaskView,
	isTerminalStatus,
} from "./models.ts";
export { BackgroundTaskStore } from "./store.ts";
export {
	buildActiveTaskSnapshot,
	formatTask,
	formatTaskList,
	listTaskViews,
} from "./summary.ts";
export { runBackgroundTaskWorker } from "./worker.ts";
export { BackgroundAgentRunner } from "./agent_runner.ts";

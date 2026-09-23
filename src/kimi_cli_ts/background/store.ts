/**
 * Background task store — corresponds to Python background/store.py
 * File-based persistence: per-task directory with spec.json, runtime.json, etc.
 */

import { join } from "node:path";
import {
	mkdirSync,
	existsSync,
	readdirSync,
	readFileSync,
	writeFileSync,
	statSync,
} from "node:fs";
import { logger } from "../utils/logging.ts";
import {
	type TaskSpec,
	type TaskRuntime,
	type TaskControl,
	type TaskConsumerState,
	type TaskView,
	type TaskOutputChunk,
	type TaskStatus,
	taskSpecToJson,
	taskSpecFromJson,
	taskRuntimeToJson,
	taskRuntimeFromJson,
	taskControlToJson,
	taskControlFromJson,
	taskConsumerToJson,
	taskConsumerFromJson,
	newTaskRuntime,
	newTaskControl,
	newTaskConsumerState,
} from "./models.ts";

const VALID_TASK_ID = /^[a-z0-9][a-z0-9\-]{1,24}$/;

function validateTaskId(taskId: string): void {
	if (!VALID_TASK_ID.test(taskId)) {
		throw new Error(`Invalid task_id: ${taskId}`);
	}
}

function atomicJsonWrite(
	data: Record<string, unknown>,
	filePath: string,
): void {
	const tmpPath = filePath + ".tmp";
	writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
	// Bun.fs.renameSync is atomic on same filesystem
	const { renameSync } = require("node:fs");
	renameSync(tmpPath, filePath);
}

export class BackgroundTaskStore {
	static readonly SPEC_FILE = "spec.json";
	static readonly RUNTIME_FILE = "runtime.json";
	static readonly CONTROL_FILE = "control.json";
	static readonly CONSUMER_FILE = "consumer.json";
	static readonly OUTPUT_FILE = "output.log";

	private _root: string;

	constructor(root: string) {
		this._root = root;
	}

	get root(): string {
		return this._root;
	}

	private ensureRoot(): string {
		if (!existsSync(this._root)) {
			mkdirSync(this._root, { recursive: true });
		}
		return this._root;
	}

	taskDir(taskId: string): string {
		validateTaskId(taskId);
		const path = join(this.ensureRoot(), taskId);
		if (!existsSync(path)) {
			mkdirSync(path, { recursive: true });
		}
		return path;
	}

	taskPath(taskId: string): string {
		validateTaskId(taskId);
		return join(this._root, taskId);
	}

	specPath(taskId: string): string {
		return join(this.taskPath(taskId), BackgroundTaskStore.SPEC_FILE);
	}

	runtimePath(taskId: string): string {
		return join(this.taskPath(taskId), BackgroundTaskStore.RUNTIME_FILE);
	}

	controlPath(taskId: string): string {
		return join(this.taskPath(taskId), BackgroundTaskStore.CONTROL_FILE);
	}

	consumerPath(taskId: string): string {
		return join(this.taskPath(taskId), BackgroundTaskStore.CONSUMER_FILE);
	}

	outputPath(taskId: string): string {
		return join(this.taskPath(taskId), BackgroundTaskStore.OUTPUT_FILE);
	}

	createTask(spec: TaskSpec): void {
		const dir = this.taskDir(spec.id);
		atomicJsonWrite(
			taskSpecToJson(spec),
			join(dir, BackgroundTaskStore.SPEC_FILE),
		);
		atomicJsonWrite(
			taskRuntimeToJson(newTaskRuntime()),
			join(dir, BackgroundTaskStore.RUNTIME_FILE),
		);
		atomicJsonWrite(
			taskControlToJson(newTaskControl()),
			join(dir, BackgroundTaskStore.CONTROL_FILE),
		);
		atomicJsonWrite(
			taskConsumerToJson(newTaskConsumerState()),
			join(dir, BackgroundTaskStore.CONSUMER_FILE),
		);
		// Touch output file
		writeFileSync(join(dir, BackgroundTaskStore.OUTPUT_FILE), "", "utf-8");
	}

	listTaskIds(): string[] {
		if (!existsSync(this._root)) return [];
		const taskIds: string[] = [];
		for (const entry of readdirSync(this._root).sort()) {
			const dirPath = join(this._root, entry);
			try {
				if (!statSync(dirPath).isDirectory()) continue;
			} catch {
				continue;
			}
			if (!existsSync(join(dirPath, BackgroundTaskStore.SPEC_FILE))) continue;
			taskIds.push(entry);
		}
		return taskIds;
	}

	writeSpec(spec: TaskSpec): void {
		atomicJsonWrite(taskSpecToJson(spec), this.specPath(spec.id));
	}

	readSpec(taskId: string): TaskSpec {
		const data = JSON.parse(readFileSync(this.specPath(taskId), "utf-8"));
		return taskSpecFromJson(data);
	}

	writeRuntime(taskId: string, runtime: TaskRuntime): void {
		atomicJsonWrite(taskRuntimeToJson(runtime), this.runtimePath(taskId));
	}

	readRuntime(taskId: string): TaskRuntime {
		const path = this.runtimePath(taskId);
		if (!existsSync(path)) return newTaskRuntime();
		try {
			const data = JSON.parse(readFileSync(path, "utf-8"));
			return taskRuntimeFromJson(data);
		} catch (err) {
			logger.warn(
				`Corrupted runtime file for task ${taskId}, using default: ${err}`,
			);
			return newTaskRuntime();
		}
	}

	writeControl(taskId: string, control: TaskControl): void {
		atomicJsonWrite(taskControlToJson(control), this.controlPath(taskId));
	}

	readControl(taskId: string): TaskControl {
		const path = this.controlPath(taskId);
		if (!existsSync(path)) return newTaskControl();
		try {
			const data = JSON.parse(readFileSync(path, "utf-8"));
			return taskControlFromJson(data);
		} catch (err) {
			logger.warn(
				`Corrupted control file for task ${taskId}, using default: ${err}`,
			);
			return newTaskControl();
		}
	}

	writeConsumer(taskId: string, consumer: TaskConsumerState): void {
		atomicJsonWrite(taskConsumerToJson(consumer), this.consumerPath(taskId));
	}

	readConsumer(taskId: string): TaskConsumerState {
		const path = this.consumerPath(taskId);
		if (!existsSync(path)) return newTaskConsumerState();
		try {
			const data = JSON.parse(readFileSync(path, "utf-8"));
			return taskConsumerFromJson(data);
		} catch (err) {
			logger.warn(
				`Corrupted consumer file for task ${taskId}, using default: ${err}`,
			);
			return newTaskConsumerState();
		}
	}

	mergedView(taskId: string): TaskView {
		return {
			spec: this.readSpec(taskId),
			runtime: this.readRuntime(taskId),
			control: this.readControl(taskId),
			consumer: this.readConsumer(taskId),
		};
	}

	listViews(): TaskView[] {
		const views: TaskView[] = [];
		for (const id of this.listTaskIds()) {
			try {
				views.push(this.mergedView(id));
			} catch (err) {
				logger.warn(`Skipping corrupted task ${id}: ${err}`);
			}
		}
		views.sort(
			(a, b) =>
				(b.runtime.updatedAt || b.spec.createdAt) -
				(a.runtime.updatedAt || a.spec.createdAt),
		);
		return views;
	}

	readOutput(
		taskId: string,
		offset: number,
		maxBytes: number,
		status: TaskStatus,
	): TaskOutputChunk {
		const path = this.outputPath(taskId);
		if (!existsSync(path)) {
			return {
				taskId,
				offset,
				nextOffset: offset,
				text: "",
				eof: true,
				status,
			};
		}

		const buf = readFileSync(path);
		const totalSize = buf.length;
		const boundedOffset = Math.min(Math.max(offset, 0), totalSize);
		const content = buf.subarray(boundedOffset, boundedOffset + maxBytes);
		const nextOffset = boundedOffset + content.length;

		return {
			taskId,
			offset: boundedOffset,
			nextOffset,
			text: content.toString("utf-8"),
			eof: nextOffset >= totalSize,
			status,
		};
	}

	tailOutput(taskId: string, maxBytes: number, maxLines: number): string {
		const path = this.outputPath(taskId);
		if (!existsSync(path)) return "";

		const buf = readFileSync(path);
		const totalSize = buf.length;
		const start = Math.max(0, totalSize - maxBytes);
		const content = buf.subarray(start);
		const text = content.toString("utf-8");
		let lines = text.split("\n");
		if (lines.length > maxLines) {
			lines = lines.slice(-maxLines);
		}
		return lines.join("\n");
	}
}

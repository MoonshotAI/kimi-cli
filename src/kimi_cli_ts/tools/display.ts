/**
 * Display block types for UI rendering.
 * Corresponds to Python tools/display.py
 */

export interface DiffDisplayBlock {
	type: "diff";
	path: string;
	oldText: string;
	newText: string;
	oldStart?: number;
	newStart?: number;
	isSummary?: boolean;
}

export interface TodoDisplayItem {
	title: string;
	status: "pending" | "in_progress" | "done";
}

export interface TodoDisplayBlock {
	type: "todo";
	items: TodoDisplayItem[];
}

export interface ShellDisplayBlock {
	type: "shell";
	language: string;
	command: string;
}

export interface BackgroundTaskDisplayBlock {
	type: "background_task";
	taskId: string;
	kind: string;
	status: string;
	description: string;
}

export type DisplayBlock =
	| DiffDisplayBlock
	| TodoDisplayBlock
	| ShellDisplayBlock
	| BackgroundTaskDisplayBlock;

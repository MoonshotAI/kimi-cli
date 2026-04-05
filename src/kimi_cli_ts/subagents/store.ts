/**
 * Subagent store — corresponds to Python subagents/store.py
 * File-based persistence for subagent instance metadata.
 */

import { join } from "node:path";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	readdirSync,
	statSync,
	rmSync,
} from "node:fs";
import { logger } from "../utils/logging.ts";
import type {
	AgentInstanceRecord,
	AgentLaunchSpec,
	SubagentStatus,
} from "./models.ts";

function recordFromJson(data: Record<string, unknown>): AgentInstanceRecord {
	const launchSpec =
		(data.launch_spec as Record<string, unknown>) ??
		(data.launchSpec as Record<string, unknown>) ??
		{};
	return {
		agentId: String(data.agent_id ?? data.agentId ?? ""),
		subagentType: String(data.subagent_type ?? data.subagentType ?? ""),
		status: String(data.status ?? "idle") as SubagentStatus,
		description: String(data.description ?? ""),
		createdAt: Number(data.created_at ?? data.createdAt ?? 0),
		updatedAt: Number(data.updated_at ?? data.updatedAt ?? 0),
		lastTaskId: (data.last_task_id ?? data.lastTaskId) as string | undefined,
		launchSpec: {
			agentId: String(launchSpec.agent_id ?? launchSpec.agentId ?? ""),
			subagentType: String(
				launchSpec.subagent_type ?? launchSpec.subagentType ?? "",
			),
			modelOverride: (launchSpec.model_override ?? launchSpec.modelOverride) as
				| string
				| undefined,
			effectiveModel: (launchSpec.effective_model ??
				launchSpec.effectiveModel) as string | undefined,
			createdAt: Number(launchSpec.created_at ?? launchSpec.createdAt ?? 0),
		},
	};
}

function recordToJson(record: AgentInstanceRecord): Record<string, unknown> {
	return {
		agent_id: record.agentId,
		subagent_type: record.subagentType,
		status: record.status,
		description: record.description,
		created_at: record.createdAt,
		updated_at: record.updatedAt,
		last_task_id: record.lastTaskId,
		launch_spec: {
			agent_id: record.launchSpec.agentId,
			subagent_type: record.launchSpec.subagentType,
			model_override: record.launchSpec.modelOverride,
			effective_model: record.launchSpec.effectiveModel,
			created_at: record.launchSpec.createdAt,
		},
	};
}

export class SubagentStore {
	private _root: string;

	constructor(root: string) {
		this._root = root;
	}

	get root(): string {
		return this._root;
	}

	instanceDir(agentId: string, create = false): string {
		const path = join(this._root, agentId);
		if (create && !existsSync(path)) {
			mkdirSync(path, { recursive: true });
		}
		return path;
	}

	contextPath(agentId: string): string {
		return join(this.instanceDir(agentId), "context.jsonl");
	}

	wirePath(agentId: string): string {
		return join(this.instanceDir(agentId), "wire.jsonl");
	}

	metaPath(agentId: string): string {
		return join(this.instanceDir(agentId), "meta.json");
	}

	promptPath(agentId: string): string {
		return join(this.instanceDir(agentId), "prompt.txt");
	}

	outputPath(agentId: string): string {
		return join(this.instanceDir(agentId), "output");
	}

	createInstance(opts: {
		agentId: string;
		description: string;
		launchSpec: AgentLaunchSpec;
	}): AgentInstanceRecord {
		this.initializeInstanceFiles(opts.agentId);
		const record: AgentInstanceRecord = {
			agentId: opts.agentId,
			subagentType: opts.launchSpec.subagentType,
			status: "idle",
			description: opts.description,
			createdAt: opts.launchSpec.createdAt,
			updatedAt: opts.launchSpec.createdAt,
			launchSpec: opts.launchSpec,
		};
		this.writeInstance(record);
		return record;
	}

	writeInstance(record: AgentInstanceRecord): void {
		const dir = this.instanceDir(record.agentId, true);
		const tmpPath = join(dir, "meta.json.tmp");
		const targetPath = join(dir, "meta.json");
		writeFileSync(
			tmpPath,
			JSON.stringify(recordToJson(record), null, 2),
			"utf-8",
		);
		const { renameSync } = require("node:fs");
		renameSync(tmpPath, targetPath);
	}

	private initializeInstanceFiles(agentId: string): void {
		const dir = this.instanceDir(agentId, true);
		for (const name of [
			"context.jsonl",
			"wire.jsonl",
			"prompt.txt",
			"output",
		]) {
			const path = join(dir, name);
			if (!existsSync(path)) {
				writeFileSync(path, "", "utf-8");
			}
		}
	}

	getInstance(agentId: string): AgentInstanceRecord | undefined {
		const meta = this.metaPath(agentId);
		if (!existsSync(meta)) return undefined;
		try {
			const data = JSON.parse(readFileSync(meta, "utf-8"));
			return recordFromJson(data);
		} catch (err) {
			logger.warn(
				`Corrupted instance record for agent ${agentId}, skipping: ${err}`,
			);
			return undefined;
		}
	}

	requireInstance(agentId: string): AgentInstanceRecord {
		const record = this.getInstance(agentId);
		if (!record) {
			throw new Error(`Subagent instance not found: ${agentId}`);
		}
		return record;
	}

	updateInstance(
		agentId: string,
		opts?: {
			status?: SubagentStatus;
			description?: string;
			lastTaskId?: string | null;
		},
	): AgentInstanceRecord {
		const current = this.requireInstance(agentId);
		const record: AgentInstanceRecord = {
			agentId: current.agentId,
			subagentType: current.subagentType,
			status: opts?.status ?? current.status,
			description: opts?.description ?? current.description,
			createdAt: current.createdAt,
			updatedAt: Date.now() / 1000,
			lastTaskId:
				opts?.lastTaskId !== undefined
					? (opts.lastTaskId ?? undefined)
					: current.lastTaskId,
			launchSpec: current.launchSpec,
		};
		this.writeInstance(record);
		return record;
	}

	listInstances(): AgentInstanceRecord[] {
		if (!existsSync(this._root)) return [];
		const records: AgentInstanceRecord[] = [];
		for (const entry of readdirSync(this._root)) {
			const dirPath = join(this._root, entry);
			try {
				if (!statSync(dirPath).isDirectory()) continue;
			} catch {
				continue;
			}
			const meta = join(dirPath, "meta.json");
			if (!existsSync(meta)) continue;
			try {
				const record = recordFromJson(JSON.parse(readFileSync(meta, "utf-8")));
				records.push(record);
			} catch (err) {
				logger.warn(`Skipping corrupted subagent instance ${entry}: ${err}`);
			}
		}
		records.sort((a, b) => b.updatedAt - a.updatedAt);
		return records;
	}

	deleteInstance(agentId: string): void {
		const dir = this.instanceDir(agentId);
		if (!existsSync(dir)) return;
		rmSync(dir, { recursive: true, force: true });
	}
}

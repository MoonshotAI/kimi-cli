/**
 * SubagentStore — file-system persistence for subagent instances.
 *
 * Python parity: `kimi_cli.subagents.store.SubagentStore`
 *
 * Layout per session:
 *   sessions/<session_id>/subagents/<agent_id>/
 *     meta.json     — SubagentInstanceRecord (status, type, timestamps)
 *     wire.jsonl    — child wire events (written by child SessionJournal)
 *
 * Atomic writes use `atomicWrite` (write-tmp-fsync-rename, Decision #104).
 * No per-instance write mutex needed — each subagent has its own directory.
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicWrite } from '../storage/atomic-write.js';
import type { SubagentStatus } from './subagent-types.js';

// ── SubagentInstanceRecord ────────────────────────────────────────────

export interface SubagentInstanceRecord {
  agent_id: string;
  subagent_type: string;
  status: SubagentStatus;
  description: string;
  parent_tool_call_id: string;
  created_at: number;
  updated_at: number;
}

// ── CreateInstanceOpts ────────────────────────────────────────────────

export interface CreateInstanceOpts {
  agentId: string;
  subagentType: string;
  description: string;
  parentToolCallId: string;
}

// ── SubagentStore ─────────────────────────────────────────────────────

export class SubagentStore {
  private readonly subagentsRoot: string;

  constructor(sessionDir: string) {
    this.subagentsRoot = join(sessionDir, 'subagents');
  }

  /** Directory for a specific subagent instance. */
  instanceDir(agentId: string): string {
    return join(this.subagentsRoot, agentId);
  }

  /** Path to meta.json for a subagent. */
  metaPath(agentId: string): string {
    return join(this.instanceDir(agentId), 'meta.json');
  }

  /** Path to wire.jsonl for a subagent. */
  wirePath(agentId: string): string {
    return join(this.instanceDir(agentId), 'wire.jsonl');
  }

  /**
   * Create a new subagent instance. Creates the directory structure and
   * writes the initial meta.json with status='created'.
   */
  async createInstance(opts: CreateInstanceOpts): Promise<SubagentInstanceRecord> {
    const dir = this.instanceDir(opts.agentId);
    await mkdir(dir, { recursive: true });

    // Initialize wire.jsonl as empty file (child journal will append)
    await writeFile(join(dir, 'wire.jsonl'), '', 'utf-8');

    const now = Date.now() / 1000;
    const record: SubagentInstanceRecord = {
      agent_id: opts.agentId,
      subagent_type: opts.subagentType,
      status: 'created',
      description: opts.description,
      parent_tool_call_id: opts.parentToolCallId,
      created_at: now,
      updated_at: now,
    };
    await this.writeRecord(record);
    return record;
  }

  /**
   * Read a subagent instance record. Returns null if not found or invalid.
   */
  async getInstance(agentId: string): Promise<SubagentInstanceRecord | null> {
    try {
      const raw = await readFile(this.metaPath(agentId), 'utf-8');
      return JSON.parse(raw) as SubagentInstanceRecord;
    } catch {
      return null;
    }
  }

  /**
   * Update fields on an existing subagent instance.
   * Bumps `updated_at` automatically.
   */
  async updateInstance(
    agentId: string,
    patch: Partial<Pick<SubagentInstanceRecord, 'status' | 'description'>>,
  ): Promise<SubagentInstanceRecord> {
    const current = await this.getInstance(agentId);
    if (current === null) {
      throw new Error(`Subagent instance not found: ${agentId}`);
    }
    const updated: SubagentInstanceRecord = {
      ...current,
      ...patch,
      updated_at: Date.now() / 1000,
    };
    await this.writeRecord(updated);
    return updated;
  }

  /**
   * List all subagent instances for this session, sorted by updated_at desc.
   */
  async listInstances(): Promise<SubagentInstanceRecord[]> {
    const records: SubagentInstanceRecord[] = [];
    let entries: string[];
    try {
      entries = await readdir(this.subagentsRoot);
    } catch {
      return records; // subagents/ doesn't exist yet
    }

    const reads = entries.map(async (entry) => {
      try {
        const metaPath = join(this.subagentsRoot, entry, 'meta.json');
        const s = await stat(metaPath);
        if (!s.isFile()) return null;
        const raw = await readFile(metaPath, 'utf-8');
        return JSON.parse(raw) as SubagentInstanceRecord;
      } catch {
        return null;
      }
    });

    const results = await Promise.all(reads);
    for (const r of results) {
      if (r !== null) {
        records.push(r);
      }
    }

    records.sort((a, b) => b.updated_at - a.updated_at);
    return records;
  }

  // ── Private ───────────────────────────────────────────────────────

  /** Atomic write: write to tmp file, fsync, then rename. */
  private async writeRecord(record: SubagentInstanceRecord): Promise<void> {
    const metaPath = this.metaPath(record.agent_id);
    await atomicWrite(metaPath, JSON.stringify(record, null, 2) + '\n');
  }
}

/**
 * PlanFileManager — Phase 18 §D.2.
 *
 * Owns the CRUD surface for `<KIMI_HOME>/plans/<slug>.md`. The slug is
 * resolved from either:
 *
 *   1. an explicit `getSlug()` closure (D.2 tests — keeps the unit
 *      under test decoupled from SessionMetaService), or
 *   2. a `SessionMetaService` instance — reads `plan_slug` out of
 *      `sessionMeta.get()` so the D.7 wire-truth round-trip path is
 *      the same one used at runtime.
 *
 * The discriminated-union deps shape keeps both callers honest without
 * leaking a partially-built union type to the outside world.
 */

import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { PathConfig } from '../session/path-config.js';
import type { SessionMetaService } from '../soul-plus/session-meta-service.js';
import { atomicWrite } from './atomic-write.js';

interface PlanFileManagerDepsBase {
  readonly paths: PathConfig;
  readonly sessionId: string;
}

interface ClosureDeps extends PlanFileManagerDepsBase {
  /** Returns the current plan slug. Invoked on every path lookup. */
  readonly getSlug: () => string;
}

interface SessionMetaDeps extends PlanFileManagerDepsBase {
  /** Source-of-truth service whose `get().plan_slug` gives the current slug. */
  readonly sessionMeta: SessionMetaService;
}

export type PlanFileManagerDeps = ClosureDeps | SessionMetaDeps;

export class PlanFileManager {
  private readonly paths: PathConfig;
  private readonly sessionId: string;
  private readonly resolveSlug: () => string;

  constructor(deps: PlanFileManagerDeps) {
    this.paths = deps.paths;
    this.sessionId = deps.sessionId;
    if ('getSlug' in deps) {
      this.resolveSlug = deps.getSlug;
    } else {
      const service = deps.sessionMeta;
      this.resolveSlug = () => {
        const slug = service.get().plan_slug;
        if (typeof slug !== 'string' || slug.length === 0) {
          // Callers in production should call SessionMetaService.setPlanSlug()
          // before any Write/Edit tool invocation in plan mode; otherwise this
          // throw surfaces as an unhandled exception. D.7 wiring in
          // TurnManager/PlanModeEnforcer is Slice 18-3 scope.
          throw new Error(
            `PlanFileManager: session ${this.sessionId} has no plan_slug — call SessionMetaService.setPlanSlug first.`,
          );
        }
        return slug;
      };
    }
  }

  getCurrentPlanPath(): string {
    return join(this.paths.home, 'plans', `${this.resolveSlug()}.md`);
  }

  async readCurrentPlan(): Promise<string | null> {
    try {
      return await readFile(this.getCurrentPlanPath(), 'utf8');
    } catch (error) {
      if (isEnoent(error)) return null;
      throw error;
    }
  }

  async writeCurrentPlan(content: string): Promise<void> {
    const path = this.getCurrentPlanPath();
    await mkdir(dirname(path), { recursive: true });
    // Atomic rename pattern — readers never observe a half-written plan
    // even when the process crashes mid-write. See `atomic-write.ts`.
    await atomicWrite(path, content);
  }

  async clearCurrentPlan(): Promise<void> {
    await rm(this.getCurrentPlanPath(), { force: true });
  }
}

function isEnoent(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

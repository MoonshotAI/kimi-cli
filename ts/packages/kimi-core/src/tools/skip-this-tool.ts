/**
 * SkipThisTool — sentinel error (Phase 14 §3.3 / decision #5).
 *
 * A tool constructor may throw `SkipThisTool` to opt out of registration
 * when its preconditions are unmet (e.g. a media tool without any
 * image/video capability). `ToolRegistry` / tool-factory code should
 * catch this specific error and silently skip — every other exception
 * surfaces as before.
 */

export class SkipThisTool extends Error {
  override readonly name = 'SkipThisTool';
  constructor(message: string) {
    super(message);
  }
}

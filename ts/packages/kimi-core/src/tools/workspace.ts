/**
 * WorkspaceConfig — defines the roots that tools are allowed to access.
 *
 * Injected through each Tool's constructor (§14.3 D11 collaboration-tool
 * injection). Never passed through Runtime (§14.3 D1): the Runtime keeps
 * its four-field shape and workspace limits stay on the Tool side.
 *
 * Paths should already be canonicalized lexically (absolute + normalized);
 * callers are responsible for normalizing before constructing this config.
 */

export interface WorkspaceConfig {
  /** Primary workspace directory (absolute, canonicalized). */
  readonly workspaceDir: string;
  /** Extra allowed roots (e.g. `--add-dir` CLI flag). */
  readonly additionalDirs: readonly string[];
}

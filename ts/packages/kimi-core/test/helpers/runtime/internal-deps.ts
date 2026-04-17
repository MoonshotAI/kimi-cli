/**
 * Internal runtime-helper barrel — merges `create-test-approval` +
 * `create-test-environment` exports so siblings can pull both through
 * a single import statement (keeps `max-dependencies` under budget
 * without changing their public surface).
 */

export {
  createTestApproval,
  createScriptedApproval,
  type ScriptedApprovalDecision,
  type CreateTestApprovalOptions,
  type CreateScriptedApprovalOptions,
  type ScriptedApprovalResult,
} from './create-test-approval.js';

export {
  createTestEnvironment,
  type CreateTestEnvironmentOptions,
  type TestEnvironment,
  type TestOsKind,
} from './create-test-environment.js';

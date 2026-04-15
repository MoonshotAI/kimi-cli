/**
 * Permission subsystem barrel — Slice 2.2 (v2 §9-E).
 *
 * Lives entirely inside SoulPlus; Soul proper never imports from here.
 * Consumers are `ToolCallOrchestrator.buildBeforeToolCall` and the
 * Slice 2.3 approval / rule-loader services.
 */

export type {
  PermissionMode,
  PermissionRule,
  PermissionRuleDecision,
  PermissionRuleScope,
} from './types.js';

export { parsePattern } from './parse-pattern.js';
export type { ParsedPattern } from './parse-pattern.js';

export { globToRegex } from './glob.js';
export { matchesRule } from './matches-rule.js';
export { checkRules } from './check-rules.js';

export { ToolPermissionDeniedError, formatMessage } from './errors.js';
export { withTimeout, ApprovalTimeoutError } from './with-timeout.js';

export { buildBeforeToolCall, DEFAULT_APPROVAL_TIMEOUT_MS } from './before-tool-call.js';
export type { BuildBeforeToolCallOptions } from './before-tool-call.js';

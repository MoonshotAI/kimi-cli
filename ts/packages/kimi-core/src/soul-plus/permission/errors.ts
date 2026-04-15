/**
 * Permission-layer error types. Thrown out of `beforeToolCall` when a
 * rule or approval denies a tool call. Soul catches `beforeToolCall`
 * throws and converts them into synthetic `tool_result{isError:true}`
 * records (§5.1 / run-turn.ts L180-L188) — so these errors never leak
 * to the process level.
 *
 * The closure in `before-tool-call.ts` uses this error type *only* for
 * the rare non-blocking paths (`request()` throws). Routine "rule says
 * deny" and "user rejected approval" return `{block:true, reason}`
 * instead, which matches Soul's BeforeToolCallResult contract.
 */

export class ToolPermissionDeniedError extends Error {
  readonly toolName: string;
  readonly isSubagent: boolean;

  constructor(toolName: string, isSubagent: boolean, reason?: string) {
    super(formatMessage(toolName, isSubagent, reason));
    this.name = 'ToolPermissionDeniedError';
    this.toolName = toolName;
    this.isSubagent = isSubagent;
  }
}

/**
 * Build the rejection-feedback string for a denied tool call. The text
 * changes depending on whether the caller is a subagent: subagents get
 * an extra "don't retry, don't bypass" nudge so they don't burn steps
 * on the same denied action (Python `rejection_error()` in
 * `kimi_cli/soul/approval.py:40-52`).
 */
export function formatMessage(toolName: string, isSubagent: boolean, reason?: string): string {
  const suffix = reason !== undefined && reason.length > 0 ? ` Reason: ${reason}` : '';
  if (isSubagent) {
    return `Tool "${toolName}" was denied.${suffix} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
  }
  return `Tool "${toolName}" was denied by permission rule.${suffix}`;
}

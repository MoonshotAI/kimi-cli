/**
 * Hook event payload builders — corresponds to Python hooks/events.py
 * Each function returns a payload dict for a specific hook event.
 */

function _base(
	event: string,
	sessionId: string,
	cwd: string,
): Record<string, unknown> {
	return { hook_event_name: event, session_id: sessionId, cwd };
}

export function preToolUse(opts: {
	sessionId: string;
	cwd: string;
	toolName: string;
	toolInput: Record<string, unknown>;
	toolCallId?: string;
}): Record<string, unknown> {
	return {
		..._base("PreToolUse", opts.sessionId, opts.cwd),
		tool_name: opts.toolName,
		tool_input: opts.toolInput,
		tool_call_id: opts.toolCallId ?? "",
	};
}

export function postToolUse(opts: {
	sessionId: string;
	cwd: string;
	toolName: string;
	toolInput: Record<string, unknown>;
	toolOutput?: string;
	toolCallId?: string;
}): Record<string, unknown> {
	return {
		..._base("PostToolUse", opts.sessionId, opts.cwd),
		tool_name: opts.toolName,
		tool_input: opts.toolInput,
		tool_output: opts.toolOutput ?? "",
		tool_call_id: opts.toolCallId ?? "",
	};
}

export function postToolUseFailure(opts: {
	sessionId: string;
	cwd: string;
	toolName: string;
	toolInput: Record<string, unknown>;
	error: string;
	toolCallId?: string;
}): Record<string, unknown> {
	return {
		..._base("PostToolUseFailure", opts.sessionId, opts.cwd),
		tool_name: opts.toolName,
		tool_input: opts.toolInput,
		error: opts.error,
		tool_call_id: opts.toolCallId ?? "",
	};
}

export function userPromptSubmit(opts: {
	sessionId: string;
	cwd: string;
	prompt: string;
}): Record<string, unknown> {
	return {
		..._base("UserPromptSubmit", opts.sessionId, opts.cwd),
		prompt: opts.prompt,
	};
}

export function stop(opts: {
	sessionId: string;
	cwd: string;
	stopHookActive?: boolean;
}): Record<string, unknown> {
	return {
		..._base("Stop", opts.sessionId, opts.cwd),
		stop_hook_active: opts.stopHookActive ?? false,
	};
}

export function stopFailure(opts: {
	sessionId: string;
	cwd: string;
	errorType: string;
	errorMessage: string;
}): Record<string, unknown> {
	return {
		..._base("StopFailure", opts.sessionId, opts.cwd),
		error_type: opts.errorType,
		error_message: opts.errorMessage,
	};
}

export function sessionStart(opts: {
	sessionId: string;
	cwd: string;
	source: string;
}): Record<string, unknown> {
	return {
		..._base("SessionStart", opts.sessionId, opts.cwd),
		source: opts.source,
	};
}

export function sessionEnd(opts: {
	sessionId: string;
	cwd: string;
	reason: string;
}): Record<string, unknown> {
	return {
		..._base("SessionEnd", opts.sessionId, opts.cwd),
		reason: opts.reason,
	};
}

export function subagentStart(opts: {
	sessionId: string;
	cwd: string;
	agentName: string;
	prompt: string;
}): Record<string, unknown> {
	return {
		..._base("SubagentStart", opts.sessionId, opts.cwd),
		agent_name: opts.agentName,
		prompt: opts.prompt,
	};
}

export function subagentStop(opts: {
	sessionId: string;
	cwd: string;
	agentName: string;
	response?: string;
}): Record<string, unknown> {
	return {
		..._base("SubagentStop", opts.sessionId, opts.cwd),
		agent_name: opts.agentName,
		response: opts.response ?? "",
	};
}

export function preCompact(opts: {
	sessionId: string;
	cwd: string;
	trigger: string;
	tokenCount: number;
}): Record<string, unknown> {
	return {
		..._base("PreCompact", opts.sessionId, opts.cwd),
		trigger: opts.trigger,
		token_count: opts.tokenCount,
	};
}

export function postCompact(opts: {
	sessionId: string;
	cwd: string;
	trigger: string;
	estimatedTokenCount: number;
}): Record<string, unknown> {
	return {
		..._base("PostCompact", opts.sessionId, opts.cwd),
		trigger: opts.trigger,
		estimated_token_count: opts.estimatedTokenCount,
	};
}

export function notification(opts: {
	sessionId: string;
	cwd: string;
	sink: string;
	notificationType: string;
	title?: string;
	body?: string;
	severity?: string;
}): Record<string, unknown> {
	return {
		..._base("Notification", opts.sessionId, opts.cwd),
		sink: opts.sink,
		notification_type: opts.notificationType,
		title: opts.title ?? "",
		body: opts.body ?? "",
		severity: opts.severity ?? "info",
	};
}

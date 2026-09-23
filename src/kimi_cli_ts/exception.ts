/**
 * Exception hierarchy — corresponds to Python exception.py
 * All custom error classes for kimi-cli.
 */

/** Base exception class for Kimi Code CLI. */
export class KimiCLIException extends Error {
	constructor(message: string) {
		super(message);
		this.name = "KimiCLIException";
	}
}

/** Configuration error. */
export class ConfigError extends KimiCLIException {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

/** Agent specification error. */
export class AgentSpecError extends KimiCLIException {
	constructor(message: string) {
		super(message);
		this.name = "AgentSpecError";
	}
}

/** Invalid tool error. */
export class InvalidToolError extends KimiCLIException {
	constructor(message: string) {
		super(message);
		this.name = "InvalidToolError";
	}
}

/** System prompt template error. */
export class SystemPromptTemplateError extends KimiCLIException {
	constructor(message: string) {
		super(message);
		this.name = "SystemPromptTemplateError";
	}
}

/** MCP config error. */
export class MCPConfigError extends KimiCLIException {
	constructor(message: string) {
		super(message);
		this.name = "MCPConfigError";
	}
}

/** MCP runtime error. */
export class MCPRuntimeError extends KimiCLIException {
	constructor(message: string) {
		super(message);
		this.name = "MCPRuntimeError";
	}
}

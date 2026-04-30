/**
 * JSON-RPC types for the Wire protocol — corresponds to Python's wire/jsonrpc.py
 * Uses Zod v4 for schema validation.
 */

import { z } from "zod/v4";
import { ContentPart, type JsonValue } from "../types.ts";
import type { Event, Request, WireMessage } from "./types.ts";
import { serializeWireMessage } from "./serde.ts";

// ── Base / Error ───────────────────────────────────────────

export const JSONRPCErrorObject = z.object({
	code: z.number(),
	message: z.string(),
	data: z.unknown().nullable().optional(),
});
export type JSONRPCErrorObject = z.infer<typeof JSONRPCErrorObject>;

/**
 * Generic JSON-RPC message used for first-pass validation.
 */
export const JSONRPCMessage = z
	.object({
		jsonrpc: z.literal("2.0").default("2.0"),
		method: z.string().nullable().optional(),
		id: z.string().nullable().optional(),
		params: z.unknown().nullable().optional(),
		result: z.unknown().nullable().optional(),
		error: JSONRPCErrorObject.nullable().optional(),
	})
	.passthrough();
export type JSONRPCMessage = z.infer<typeof JSONRPCMessage>;

export function methodIsInbound(msg: JSONRPCMessage): boolean {
	return msg.method != null && JSONRPC_IN_METHODS.has(msg.method);
}

export function isRequest(msg: JSONRPCMessage): boolean {
	return msg.method != null && msg.id != null;
}

export function isNotification(msg: JSONRPCMessage): boolean {
	return msg.method != null && msg.id == null;
}

export function isResponse(msg: JSONRPCMessage): boolean {
	return msg.method == null && msg.id != null;
}

// ── Success / Error Responses ──────────────────────────────

export const JSONRPCSuccessResponse = z.object({
	jsonrpc: z.literal("2.0").default("2.0"),
	id: z.string(),
	result: z.unknown(),
});
export type JSONRPCSuccessResponse = z.infer<typeof JSONRPCSuccessResponse>;

export const JSONRPCErrorResponse = z.object({
	jsonrpc: z.literal("2.0").default("2.0"),
	id: z.string(),
	error: JSONRPCErrorObject,
});
export type JSONRPCErrorResponse = z.infer<typeof JSONRPCErrorResponse>;

export const JSONRPCErrorResponseNullableID = z.object({
	jsonrpc: z.literal("2.0").default("2.0"),
	id: z.string().nullable(),
	error: JSONRPCErrorObject,
});
export type JSONRPCErrorResponseNullableID = z.infer<
	typeof JSONRPCErrorResponseNullableID
>;

// ── Support Types ──────────────────────────────────────────

export const ClientInfo = z.object({
	name: z.string(),
	version: z.string().nullable().optional(),
});
export type ClientInfo = z.infer<typeof ClientInfo>;

export const ExternalTool = z.object({
	name: z.string(),
	description: z.string(),
	parameters: z.record(z.string(), z.unknown()).optional(),
	input_schema: z.record(z.string(), z.unknown()).optional(),
}).transform((val) => ({
	name: val.name,
	description: val.description,
	parameters: val.parameters ?? val.input_schema ?? {},
}));
export type ExternalTool = z.infer<typeof ExternalTool>;

export const ClientCapabilities = z.object({
	supports_question: z.boolean().default(false),
	supports_plan_mode: z.boolean().default(false),
});
export type ClientCapabilities = z.infer<typeof ClientCapabilities>;

export const WireHookSubscription = z.object({
	id: z.string(),
	event: z.string(),
	matcher: z.string().default(""),
	timeout: z.number().default(30),
});
export type WireHookSubscription = z.infer<typeof WireHookSubscription>;

// ── Inbound Messages ───────────────────────────────────────

export const JSONRPCInitializeParams = z.object({
	protocol_version: z.string(),
	client: ClientInfo.nullable().optional(),
	external_tools: z.array(ExternalTool).nullable().optional(),
	hooks: z.array(WireHookSubscription).nullable().optional(),
	capabilities: ClientCapabilities.nullable().optional(),
});
export type JSONRPCInitializeParams = z.infer<typeof JSONRPCInitializeParams>;

export const JSONRPCInitializeMessage = z.object({
	jsonrpc: z.literal("2.0").default("2.0"),
	method: z.literal("initialize").default("initialize"),
	id: z.string(),
	params: JSONRPCInitializeParams,
});
export type JSONRPCInitializeMessage = z.infer<typeof JSONRPCInitializeMessage>;

export const JSONRPCPromptParams = z.object({
	user_input: z.union([z.string(), z.array(ContentPart)]),
});
export type JSONRPCPromptParams = z.infer<typeof JSONRPCPromptParams>;

export const JSONRPCPromptMessage = z.object({
	jsonrpc: z.literal("2.0").default("2.0"),
	method: z.literal("prompt").default("prompt"),
	id: z.string(),
	params: JSONRPCPromptParams,
});
export type JSONRPCPromptMessage = z.infer<typeof JSONRPCPromptMessage>;

export const JSONRPCReplayMessage = z.object({
	jsonrpc: z.literal("2.0").default("2.0"),
	method: z.literal("replay").default("replay"),
	id: z.string(),
	params: z.unknown().nullable().optional(),
});
export type JSONRPCReplayMessage = z.infer<typeof JSONRPCReplayMessage>;

export const JSONRPCSteerParams = z.object({
	user_input: z.union([z.string(), z.array(ContentPart)]),
});
export type JSONRPCSteerParams = z.infer<typeof JSONRPCSteerParams>;

export const JSONRPCSteerMessage = z.object({
	jsonrpc: z.literal("2.0").default("2.0"),
	method: z.literal("steer").default("steer"),
	id: z.string(),
	params: JSONRPCSteerParams,
});
export type JSONRPCSteerMessage = z.infer<typeof JSONRPCSteerMessage>;

export const JSONRPCSetPlanModeParams = z
	.object({
		enabled: z.boolean(),
	})
	.passthrough();
export type JSONRPCSetPlanModeParams = z.infer<typeof JSONRPCSetPlanModeParams>;

export const JSONRPCSetPlanModeMessage = z.object({
	jsonrpc: z.literal("2.0").default("2.0"),
	method: z.literal("set_plan_mode").default("set_plan_mode"),
	id: z.string(),
	params: JSONRPCSetPlanModeParams,
});
export type JSONRPCSetPlanModeMessage = z.infer<
	typeof JSONRPCSetPlanModeMessage
>;

export const JSONRPCCancelMessage = z.object({
	jsonrpc: z.literal("2.0").default("2.0"),
	method: z.literal("cancel").default("cancel"),
	id: z.string(),
	params: z.unknown().nullable().optional(),
});
export type JSONRPCCancelMessage = z.infer<typeof JSONRPCCancelMessage>;

// ── Outbound Messages ──────────────────────────────────────

export interface JSONRPCEventMessage {
	jsonrpc: "2.0";
	method: "event";
	params: Record<string, unknown>;
}

export function createEventMessage(event: WireMessage): JSONRPCEventMessage {
	return {
		jsonrpc: "2.0",
		method: "event",
		params: serializeWireMessage(event),
	};
}

export interface JSONRPCRequestMessage {
	jsonrpc: "2.0";
	method: "request";
	id: string;
	params: Record<string, unknown>;
}

export function createRequestMessage(
	id: string,
	request: Request,
): JSONRPCRequestMessage {
	return {
		jsonrpc: "2.0",
		method: "request",
		id,
		params: serializeWireMessage(request),
	};
}

// ── Union Types ────────────────────────────────────────────

export type JSONRPCInMessage =
	| JSONRPCSuccessResponse
	| JSONRPCErrorResponse
	| JSONRPCInitializeMessage
	| JSONRPCPromptMessage
	| JSONRPCSteerMessage
	| JSONRPCReplayMessage
	| JSONRPCSetPlanModeMessage
	| JSONRPCCancelMessage;

export type JSONRPCOutMessage =
	| JSONRPCSuccessResponse
	| JSONRPCErrorResponse
	| JSONRPCErrorResponseNullableID
	| JSONRPCEventMessage
	| JSONRPCRequestMessage;

export const JSONRPC_IN_METHODS = new Set([
	"initialize",
	"prompt",
	"steer",
	"replay",
	"set_plan_mode",
	"cancel",
]);

export const JSONRPC_OUT_METHODS = new Set(["event", "request"]);

/**
 * Parse a raw JSON object into a typed inbound message.
 * Discriminates based on `method` field.
 */
export function parseInboundMessage(data: unknown): JSONRPCInMessage {
	const obj = data as Record<string, unknown>;
	const method = obj.method as string | undefined;

	if (method == null) {
		// It's a response
		if (obj.error != null) {
			return JSONRPCErrorResponse.parse(data);
		}
		return JSONRPCSuccessResponse.parse(data);
	}

	switch (method) {
		case "initialize":
			return JSONRPCInitializeMessage.parse(data);
		case "prompt":
			return JSONRPCPromptMessage.parse(data);
		case "replay":
			return JSONRPCReplayMessage.parse(data);
		case "steer":
			return JSONRPCSteerMessage.parse(data);
		case "set_plan_mode":
			return JSONRPCSetPlanModeMessage.parse(data);
		case "cancel":
			return JSONRPCCancelMessage.parse(data);
		default:
			throw new Error(`Unknown inbound method: ${method}`);
	}
}

// ── Error Codes ────────────────────────────────────────────

export const ErrorCodes = {
	// Predefined JSON-RPC 2.0 error codes
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,
	// Application-specific error codes
	INVALID_STATE: -32000,
	LLM_NOT_SET: -32001,
	LLM_NOT_SUPPORTED: -32002,
	CHAT_PROVIDER_ERROR: -32003,
	AUTH_EXPIRED: -32004,
} as const;

export const Statuses = {
	FINISHED: "finished",
	CANCELLED: "cancelled",
	MAX_STEPS_REACHED: "max_steps_reached",
	STEERED: "steered",
} as const;

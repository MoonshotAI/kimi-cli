/**
 * Wire serialization/deserialization — corresponds to Python's wire/serde.py
 */

import {
	type WireMessage,
	type WireMessageEnvelope,
	WireMessageEnvelopeSchema,
	_wireMessageSchemas,
	fromEnvelope,
	toEnvelope,
} from "./types.ts";

/**
 * Recursively strip __wireType hints from nested objects.
 * This ensures internal formatting tags don't leak into the wire protocol.
 */
function stripWireTypeDeep(obj: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			const nested = value as Record<string, unknown>;
			if ("__wireType" in nested) {
				const { __wireType: _, ...clean } = nested;
				result[key] = stripWireTypeDeep(clean);
			} else {
				result[key] = stripWireTypeDeep(nested);
			}
		} else {
			result[key] = value;
		}
	}
	return result;
}

/**
 * Map internal type names to wire protocol names.
 * Python serializes TextPart and ThinkPart as "ContentPart" on the wire.
 * We keep the internal names for readability but remap for wire compat.
 */
const _wireTypeNameMap: Record<string, string> = {
	TextPart: "ContentPart",
	ThinkPart: "ContentPart",
};

/**
 * Detect the type name of a WireMessage.
 * Uses __wireType hint if available (fast path from wireSend),
 * otherwise falls back to trial-parsing each schema.
 */
function detectTypeName(msg: Record<string, unknown>): string | null {
	// Fast path: tagged messages from wireSend()
	if (
		typeof msg.__wireType === "string" &&
		msg.__wireType in _wireMessageSchemas
	) {
		return msg.__wireType;
	}
	// Slow path: trial-parse each schema
	for (const [name, schema] of Object.entries(_wireMessageSchemas)) {
		const result = schema.safeParse(msg);
		if (result.success) return name;
	}
	return null;
}

/**
 * Serialize a wire message to a JSON-friendly envelope object.
 *
 * Overloads:
 * - (typeName, payload): explicit type name + payload
 * - (msg): auto-detect type from a WireMessage object
 */
export function serializeWireMessage(
	msg: WireMessage | Record<string, unknown>,
): Record<string, unknown>;
export function serializeWireMessage(
	typeName: string,
	payload: Record<string, unknown>,
): Record<string, unknown>;
export function serializeWireMessage(
	typeNameOrMsg: string | WireMessage | Record<string, unknown>,
	payload?: Record<string, unknown>,
): Record<string, unknown> {
	if (typeof typeNameOrMsg === "string") {
		const wireName = _wireTypeNameMap[typeNameOrMsg] ?? typeNameOrMsg;
		return toEnvelope(wireName, payload!) as Record<string, unknown>;
	}

	// Auto-detect type name from message object
	const msg = typeNameOrMsg as Record<string, unknown>;
	const rawTypeName = detectTypeName(msg);
	if (!rawTypeName) {
		throw new Error(
			`Cannot detect wire message type for: ${JSON.stringify(msg)}`,
		);
	}
	// Remap internal type names to wire protocol names (e.g. TextPart → ContentPart)
	const typeName = _wireTypeNameMap[rawTypeName] ?? rawTypeName;
	// Strip __wireType hint from serialized payload (recursively)
	const { __wireType: _, ...cleanPayload } = msg;
	return toEnvelope(typeName, stripWireTypeDeep(cleanPayload)) as Record<string, unknown>;
}

/**
 * Deserialize a JSON object into a validated wire message.
 * @param data Raw JSON object with `type` and `payload` fields
 * @returns The type name and parsed message
 * @throws if the type is unknown or the payload is invalid
 */
export function deserializeWireMessage(data: unknown): {
	typeName: string;
	message: unknown;
} {
	const envelope = WireMessageEnvelopeSchema.parse(data);
	return fromEnvelope(envelope);
}

/**
 * Serialize a wire message to a JSON string.
 */
export function serializeWireMessageToJSON(
	typeName: string,
	payload: Record<string, unknown>,
): string {
	return JSON.stringify(serializeWireMessage(typeName, payload));
}

/**
 * Deserialize a JSON string into a validated wire message.
 */
export function deserializeWireMessageFromJSON(json: string): {
	typeName: string;
	message: unknown;
} {
	const data = JSON.parse(json);
	return deserializeWireMessage(data);
}

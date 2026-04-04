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
 * Detect the type name of a WireMessage by trying each schema.
 * Returns the first matching type name.
 */
function detectTypeName(msg: Record<string, unknown>): string | null {
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
  msg: WireMessage | Record<string, unknown>
): Record<string, unknown>;
export function serializeWireMessage(
  typeName: string,
  payload: Record<string, unknown>
): Record<string, unknown>;
export function serializeWireMessage(
  typeNameOrMsg: string | WireMessage | Record<string, unknown>,
  payload?: Record<string, unknown>
): Record<string, unknown> {
  if (typeof typeNameOrMsg === "string") {
    return toEnvelope(typeNameOrMsg, payload!) as Record<string, unknown>;
  }

  // Auto-detect type name from message object
  const msg = typeNameOrMsg as Record<string, unknown>;
  const typeName = detectTypeName(msg);
  if (!typeName) {
    throw new Error(`Cannot detect wire message type for: ${JSON.stringify(msg)}`);
  }
  return toEnvelope(typeName, msg) as Record<string, unknown>;
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
  payload: Record<string, unknown>
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

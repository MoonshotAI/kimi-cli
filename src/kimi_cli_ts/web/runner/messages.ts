/**
 * Web runner messages — corresponds to Python web/runner/messages.py
 * JSON-RPC message helpers for session status and history replay.
 */

import { randomUUID } from "node:crypto";
import type { SessionStatus } from "../models.ts";
import type { ServerWebSocket } from "bun";

// ── JSON-RPC session status notification ─────────────────

export interface JSONRPCSessionStatusMessage {
	jsonrpc: "2.0";
	method: "session_status";
	params: SessionStatus;
}

export function newSessionStatusMessage(
	status: SessionStatus,
): JSONRPCSessionStatusMessage {
	return {
		jsonrpc: "2.0",
		method: "session_status",
		params: status,
	};
}

// ── JSON-RPC history_complete notification ────────────────

export interface JSONRPCHistoryCompleteMessage {
	jsonrpc: "2.0";
	method: "history_complete";
	id: string;
}

export function newHistoryCompleteMessage(): JSONRPCHistoryCompleteMessage {
	return {
		jsonrpc: "2.0",
		method: "history_complete",
		id: randomUUID(),
	};
}

/**
 * Send history_complete message to a WebSocket.
 * Returns true if sent successfully, false otherwise.
 */
export function sendHistoryComplete(ws: ServerWebSocket<unknown>): boolean {
	try {
		ws.send(JSON.stringify(newHistoryCompleteMessage()));
		return true;
	} catch {
		return false;
	}
}

/**
 * Mermaid flowchart parser — corresponds to Python skill/flow/mermaid.py
 */

import {
	type Flow,
	type FlowEdge,
	type FlowNode,
	type FlowNodeKind,
	FlowParseError,
	validateFlow,
} from "./index.ts";

interface NodeSpec {
	nodeId: string;
	label: string | undefined;
}

interface NodeDef {
	node: FlowNode;
	explicit: boolean;
}

const NODE_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*/;
const HEADER_RE = /^(flowchart|graph)\b/i;

const SHAPES: Record<string, string> = { "[": "]", "(": ")", "{": "}" };
const PIPE_LABEL_RE = /\|([^|]*)\|/;
const EDGE_LABEL_RE = /--\s*([^>-][^>]*)\s*-->/;
const ARROW_RE = /[-.=]+>/g;

export function parseMermaidFlowchart(text: string): Flow {
	const nodes = new Map<string, NodeDef>();
	const outgoing = new Map<string, FlowEdge[]>();

	for (const [lineNo, rawLine] of text.split("\n").entries()) {
		const line = stripComment(rawLine).trim();
		if (!line || line.startsWith("%%")) continue;
		if (HEADER_RE.test(line)) continue;
		if (isStyleLine(line)) continue;
		const cleaned = stripStyleTokens(line);

		const edge = tryParseEdgeLine(cleaned, lineNo + 1);
		if (edge) {
			const [srcSpec, label, dstSpec] = edge;
			const srcNode = addNode(nodes, srcSpec, lineNo + 1);
			const dstNode = addNode(nodes, dstSpec, lineNo + 1);
			const flowEdge: FlowEdge = { src: srcNode.id, dst: dstNode.id, label };
			if (!outgoing.has(flowEdge.src)) outgoing.set(flowEdge.src, []);
			outgoing.get(flowEdge.src)!.push(flowEdge);
			if (!outgoing.has(flowEdge.dst)) outgoing.set(flowEdge.dst, []);
			continue;
		}

		const nodeSpec = tryParseNodeLine(cleaned, lineNo + 1);
		if (nodeSpec) addNode(nodes, nodeSpec, lineNo + 1);
	}

	const flowNodes: Record<string, FlowNode> = {};
	for (const [id, def] of nodes) {
		flowNodes[id] = def.node;
		if (!outgoing.has(id)) outgoing.set(id, []);
	}

	const outgoingRecord: Record<string, FlowEdge[]> = {};
	for (const [k, v] of outgoing) outgoingRecord[k] = v;

	const inferred = inferDecisionNodes(flowNodes, outgoingRecord);
	const [beginId, endId] = validateFlow(inferred, outgoingRecord);
	return { nodes: inferred, outgoing: outgoingRecord, beginId, endId };
}

function tryParseEdgeLine(
	line: string,
	lineNo: number,
): [NodeSpec, string | undefined, NodeSpec] | undefined {
	let srcSpec: NodeSpec;
	let idx: number;
	try {
		[srcSpec, idx] = parseNodeToken(line, 0, lineNo);
	} catch {
		return undefined;
	}

	const [normalized, label] = normalizeEdgeLine(line);
	idx = skipWs(normalized, idx);
	let norm = normalized;
	if (!norm.slice(idx).includes(">")) {
		if (!norm.slice(idx).includes("---")) return undefined;
		norm = norm.slice(0, idx) + norm.slice(idx).replace("---", "-->");
	}

	norm = norm.replace(ARROW_RE, "-->");
	const arrowIdx = norm.lastIndexOf(">");
	if (arrowIdx === -1) return undefined;

	const dstStart = skipWs(norm, arrowIdx + 1);
	let dstSpec: NodeSpec;
	try {
		[dstSpec] = parseNodeToken(norm, dstStart, lineNo);
	} catch {
		return undefined;
	}

	return [srcSpec, label, dstSpec];
}

function parseNodeToken(
	line: string,
	idx: number,
	lineNo: number,
): [NodeSpec, number] {
	const match = line.slice(idx).match(NODE_ID_RE);
	if (!match) throw new FlowParseError(lineError(lineNo, "Expected node id"));
	const nodeId = match[0]!;
	idx += match[0]!.length;

	if (idx >= line.length || !(line[idx]! in SHAPES)) {
		return [{ nodeId, label: undefined }, idx];
	}

	const closeChar = SHAPES[line[idx]!]!;
	idx++;
	const [label, newIdx] = parseLabel(line, idx, closeChar, lineNo);
	return [{ nodeId, label }, newIdx];
}

function parseLabel(
	line: string,
	idx: number,
	closeChar: string,
	lineNo: number,
): [string, number] {
	if (idx >= line.length)
		throw new FlowParseError(lineError(lineNo, "Expected node label"));

	if (closeChar === ")" && line[idx] === "[") {
		const [label, newIdx] = parseLabel(line, idx + 1, "]", lineNo);
		let i = newIdx;
		while (i < line.length && line[i] === " ") i++;
		if (i >= line.length || line[i] !== ")") {
			throw new FlowParseError(lineError(lineNo, "Unclosed node label"));
		}
		return [label, i + 1];
	}

	if (line[idx] === '"') {
		idx++;
		const buf: string[] = [];
		while (idx < line.length) {
			const ch = line[idx]!;
			if (ch === '"') {
				idx++;
				while (idx < line.length && line[idx] === " ") idx++;
				if (idx >= line.length || line[idx] !== closeChar) {
					throw new FlowParseError(lineError(lineNo, "Unclosed node label"));
				}
				return [buf.join(""), idx + 1];
			}
			if (ch === "\\" && idx + 1 < line.length) {
				buf.push(line[idx + 1]!);
				idx += 2;
				continue;
			}
			buf.push(ch);
			idx++;
		}
		throw new FlowParseError(lineError(lineNo, "Unclosed quoted label"));
	}

	const end = line.indexOf(closeChar, idx);
	if (end === -1)
		throw new FlowParseError(lineError(lineNo, "Unclosed node label"));
	const label = line.slice(idx, end).trim();
	if (!label)
		throw new FlowParseError(lineError(lineNo, "Node label cannot be empty"));
	return [label, end + 1];
}

function skipWs(line: string, idx: number): number {
	while (idx < line.length && line[idx] === " ") idx++;
	return idx;
}

function addNode(
	nodes: Map<string, NodeDef>,
	spec: NodeSpec,
	lineNo: number,
): FlowNode {
	const label = spec.label ?? spec.nodeId;
	const labelNorm = label.trim().toLowerCase();
	if (!label)
		throw new FlowParseError(lineError(lineNo, "Node label cannot be empty"));

	let kind: FlowNodeKind = "task";
	if (labelNorm === "begin") kind = "begin";
	else if (labelNorm === "end") kind = "end";

	const node: FlowNode = { id: spec.nodeId, label, kind };
	const explicit = spec.label != null;
	const existing = nodes.get(spec.nodeId);

	if (!existing) {
		nodes.set(spec.nodeId, { node, explicit });
		return node;
	}

	if (
		existing.node.id === node.id &&
		existing.node.label === node.label &&
		existing.node.kind === node.kind
	) {
		return existing.node;
	}

	if (!explicit && existing.explicit) return existing.node;
	if (explicit && !existing.explicit) {
		nodes.set(spec.nodeId, { node, explicit: true });
		return node;
	}

	throw new FlowParseError(
		lineError(lineNo, `Conflicting definition for node "${spec.nodeId}"`),
	);
}

function lineError(lineNo: number, message: string): string {
	return `Line ${lineNo}: ${message}`;
}

function stripComment(line: string): string {
	if (!line.includes("%%")) return line;
	return line.split("%%")[0]!;
}

function isStyleLine(line: string): boolean {
	const lowered = line.toLowerCase();
	if (lowered === "end") return true;
	return (
		lowered.startsWith("classdef ") ||
		lowered.startsWith("class ") ||
		lowered.startsWith("style ") ||
		lowered.startsWith("linkstyle ") ||
		lowered.startsWith("click ") ||
		lowered.startsWith("subgraph ") ||
		lowered.startsWith("direction ")
	);
}

function stripStyleTokens(line: string): string {
	return line.replace(/:::[A-Za-z0-9_-]+/g, "");
}

function tryParseNodeLine(line: string, lineNo: number): NodeSpec | undefined {
	try {
		const [spec] = parseNodeToken(line, 0, lineNo);
		return spec;
	} catch {
		return undefined;
	}
}

function normalizeEdgeLine(line: string): [string, string | undefined] {
	let label: string | undefined;
	let normalized = line;

	const pipeMatch = PIPE_LABEL_RE.exec(normalized);
	if (pipeMatch) {
		label = pipeMatch[1]!.trim() || undefined;
		normalized =
			normalized.slice(0, pipeMatch.index) +
			normalized.slice(pipeMatch.index! + pipeMatch[0]!.length);
	}

	if (label == null) {
		const edgeMatch = EDGE_LABEL_RE.exec(normalized);
		if (edgeMatch) {
			label = edgeMatch[1]!.trim() || undefined;
			normalized =
				normalized.slice(0, edgeMatch.index) +
				"-->" +
				normalized.slice(edgeMatch.index! + edgeMatch[0]!.length);
		}
	}

	return [normalized, label];
}

function inferDecisionNodes(
	nodes: Record<string, FlowNode>,
	outgoing: Record<string, FlowEdge[]>,
): Record<string, FlowNode> {
	const updated: Record<string, FlowNode> = {};
	for (const [nodeId, node] of Object.entries(nodes)) {
		let kind = node.kind;
		if (kind === "task" && (outgoing[nodeId]?.length ?? 0) > 1) {
			kind = "decision";
		}
		if (kind !== node.kind) {
			updated[nodeId] = { id: node.id, label: node.label, kind };
		} else {
			updated[nodeId] = node;
		}
	}
	return updated;
}

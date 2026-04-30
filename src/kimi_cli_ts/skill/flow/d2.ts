/**
 * D2 flowchart parser — corresponds to Python skill/flow/d2.py
 */

import {
	type Flow,
	type FlowEdge,
	type FlowNode,
	type FlowNodeKind,
	FlowParseError,
	validateFlow,
} from "./index.ts";

const NODE_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]*/;
const BLOCK_TAG_RE = /^\|md$/;
const PROPERTY_SEGMENTS = new Set([
	"shape",
	"style",
	"label",
	"link",
	"icon",
	"near",
	"width",
	"height",
	"direction",
	"grid-rows",
	"grid-columns",
	"grid-gap",
	"font-size",
	"font-family",
	"font-color",
	"stroke",
	"fill",
	"opacity",
	"padding",
	"border-radius",
	"shadow",
	"sketch",
	"animated",
	"multiple",
	"constraint",
	"tooltip",
]);

interface NodeDef {
	node: FlowNode;
	explicit: boolean;
}

export function parseD2Flowchart(text: string): Flow {
	const normalized = normalizeMarkdownBlocks(text);
	const nodes = new Map<string, NodeDef>();
	const outgoing = new Map<string, FlowEdge[]>();

	for (const [lineNo, statement] of iterTopLevelStatements(normalized)) {
		if (hasUnquotedToken(statement, "->")) {
			parseEdgeStatement(statement, lineNo, nodes, outgoing);
		} else {
			parseNodeStatement(statement, lineNo, nodes);
		}
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

function normalizeMarkdownBlocks(text: string): string {
	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const lines = normalized.split("\n");
	const outLines: string[] = [];
	let i = 0;
	let lineNo = 1;

	while (i < lines.length) {
		const line = lines[i]!;
		const [prefix, suffix] = splitUnquotedOnce(line, ":");

		if (suffix == null) {
			outLines.push(line);
			i++;
			lineNo++;
			continue;
		}

		const suffixClean = stripUnquotedComment(suffix).trim();
		if (!BLOCK_TAG_RE.test(suffixClean)) {
			outLines.push(line);
			i++;
			lineNo++;
			continue;
		}

		const startLine = lineNo;
		const blockLines: string[] = [];
		i++;
		lineNo++;
		while (i < lines.length) {
			const blockLine = lines[i]!;
			if (blockLine.trim() === "|") break;
			blockLines.push(blockLine);
			i++;
			lineNo++;
		}
		if (i >= lines.length) {
			throw new FlowParseError(lineError(startLine, "Unclosed markdown block"));
		}

		const dedented = dedentBlock(blockLines);
		if (dedented.length > 0 && dedented.some((l) => l.length > 0)) {
			const escaped = dedented.map(escapeQuotedLine);
			outLines.push(`${prefix}: "${escaped[0]}`);
			for (let j = 1; j < escaped.length; j++) {
				outLines.push(escaped[j]!);
			}
			outLines[outLines.length - 1] = `${outLines[outLines.length - 1]}"`;
			outLines.push("", "");
		} else {
			outLines.push(`${prefix}: ""`);
			outLines.push("");
		}

		i++;
		lineNo++;
	}

	return outLines.join("\n");
}

function stripUnquotedComment(text: string): string {
	let inSingle = false;
	let inDouble = false;
	let escape = false;
	for (let idx = 0; idx < text.length; idx++) {
		const ch = text[idx]!;
		if (escape) {
			escape = false;
			continue;
		}
		if (ch === "\\" && (inSingle || inDouble)) {
			escape = true;
			continue;
		}
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (ch === "#" && !inSingle && !inDouble) return text.slice(0, idx);
	}
	return text;
}

function dedentBlock(lines: string[]): string[] {
	let indent: number | undefined;
	for (const line of lines) {
		if (!line.trim()) continue;
		const stripped = line.replace(/^[ \t]+/, "");
		const lead = line.length - stripped.length;
		if (indent === undefined || lead < indent) indent = lead;
	}
	if (indent === undefined) return lines.map(() => "");
	return lines.map((line) =>
		line.length >= indent! ? line.slice(indent!) : "",
	);
}

function escapeQuotedLine(line: string): string {
	return line.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function* iterTopLevelStatements(text: string): Generator<[number, string]> {
	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	let braceDepth = 0;
	let inSingle = false;
	let inDouble = false;
	let escape = false;
	let dropLine = false;
	let buf: string[] = [];
	let lineNo = 1;
	let stmtLine = 1;
	let i = 0;

	while (i < normalized.length) {
		const ch = normalized[i]!;
		const nextCh = i + 1 < normalized.length ? normalized[i + 1]! : "";

		if (ch === "\\" && nextCh === "\n") {
			i += 2;
			lineNo++;
			continue;
		}

		if (ch === "\n") {
			if ((inSingle || inDouble) && braceDepth === 0 && !dropLine) {
				buf.push("\n");
				lineNo++;
				i++;
				continue;
			}
			if (braceDepth === 0 && !inSingle && !inDouble && !dropLine) {
				const statement = buf.join("").trim();
				if (statement) yield [stmtLine, statement];
			}
			buf = [];
			dropLine = false;
			stmtLine = lineNo + 1;
			lineNo++;
			i++;
			continue;
		}

		if (!inSingle && !inDouble) {
			if (ch === "#") {
				while (i < normalized.length && normalized[i] !== "\n") i++;
				continue;
			}
			if (ch === "{") {
				if (braceDepth === 0) {
					const statement = buf.join("").trim();
					if (statement) yield [stmtLine, statement];
					dropLine = true;
					buf = [];
				}
				braceDepth++;
				i++;
				continue;
			}
			if (ch === "}" && braceDepth > 0) {
				braceDepth--;
				i++;
				continue;
			}
			if (ch === "}" && braceDepth === 0) {
				throw new FlowParseError(lineError(lineNo, "Unmatched '}'"));
			}
		}

		if (ch === "'" && !inDouble && !escape) inSingle = !inSingle;
		else if (ch === '"' && !inSingle && !escape) inDouble = !inDouble;

		if (escape) escape = false;
		else if (ch === "\\" && (inSingle || inDouble)) escape = true;

		if (braceDepth === 0 && !dropLine) buf.push(ch);
		i++;
	}

	if (braceDepth !== 0)
		throw new FlowParseError(lineError(lineNo, "Unclosed '{' block"));
	if (inSingle || inDouble)
		throw new FlowParseError(lineError(lineNo, "Unclosed string"));

	const statement = buf.join("").trim();
	if (statement) yield [stmtLine, statement];
}

function hasUnquotedToken(text: string, token: string): boolean {
	return splitOnToken(text, token).length > 1;
}

function parseEdgeStatement(
	statement: string,
	lineNo: number,
	nodes: Map<string, NodeDef>,
	outgoing: Map<string, FlowEdge[]>,
): void {
	const parts = splitOnToken(statement, "->");
	if (parts.length < 2)
		throw new FlowParseError(lineError(lineNo, "Expected edge arrow"));

	const lastPart = parts[parts.length - 1]!;
	const [targetText, edgeLabel] = splitUnquotedOnce(lastPart, ":");
	parts[parts.length - 1] = targetText;

	const nodeIds: string[] = [];
	for (let idx = 0; idx < parts.length; idx++) {
		const nodeId = parseNodeId(parts[idx]!, lineNo, idx < parts.length - 1);
		nodeIds.push(nodeId);
	}

	if (nodeIds.some(isPropertyPath)) return;
	if (nodeIds.length < 2)
		throw new FlowParseError(
			lineError(lineNo, "Edge must have at least two nodes"),
		);

	const label =
		edgeLabel != null ? parseLabelText(edgeLabel, lineNo) : undefined;
	for (let idx = 0; idx < nodeIds.length - 1; idx++) {
		const edge: FlowEdge = {
			src: nodeIds[idx]!,
			dst: nodeIds[idx + 1]!,
			label: idx === nodeIds.length - 2 ? label : undefined,
		};
		if (!outgoing.has(edge.src)) outgoing.set(edge.src, []);
		outgoing.get(edge.src)!.push(edge);
		if (!outgoing.has(edge.dst)) outgoing.set(edge.dst, []);
	}

	for (const nodeId of nodeIds) {
		addNode(nodes, nodeId, undefined, false, lineNo);
	}
}

function parseNodeStatement(
	statement: string,
	lineNo: number,
	nodes: Map<string, NodeDef>,
): void {
	const [nodeText, labelText] = splitUnquotedOnce(statement, ":");
	if (labelText != null && isPropertyPath(nodeText)) return;
	const nodeId = parseNodeId(nodeText, lineNo, false);
	let label: string | undefined;
	let explicit = false;
	if (labelText != null && !labelText.trim()) return;
	if (labelText != null) {
		label = parseLabelText(labelText, lineNo);
		explicit = true;
	}
	addNode(nodes, nodeId, label, explicit, lineNo);
}

function parseNodeId(
	text: string,
	lineNo: number,
	allowInlineLabel: boolean,
): string {
	let cleaned = text.trim();
	if (allowInlineLabel && cleaned.includes(":")) {
		cleaned = splitUnquotedOnce(cleaned, ":")[0].trim();
	}
	if (!cleaned) throw new FlowParseError(lineError(lineNo, "Expected node id"));
	const match = cleaned.match(NODE_ID_RE);
	if (!match || match[0] !== cleaned) {
		throw new FlowParseError(lineError(lineNo, `Invalid node id "${cleaned}"`));
	}
	return match[0]!;
}

function isPropertyPath(nodeId: string): boolean {
	if (!nodeId.includes(".")) return false;
	const parts = nodeId.split(".").filter(Boolean);
	for (let i = 1; i < parts.length; i++) {
		if (PROPERTY_SEGMENTS.has(parts[i]!) || parts[i]!.startsWith("style"))
			return true;
	}
	return PROPERTY_SEGMENTS.has(parts[parts.length - 1]!);
}

function parseLabelText(text: string, lineNo: number): string {
	const label = text.trim();
	if (!label)
		throw new FlowParseError(lineError(lineNo, "Label cannot be empty"));
	if (label[0] === "'" || label[0] === '"')
		return parseQuotedLabel(label, lineNo);
	return label;
}

function parseQuotedLabel(text: string, lineNo: number): string {
	const quote = text[0]!;
	const buf: string[] = [];
	let escape = false;
	let i = 1;
	while (i < text.length) {
		const ch = text[i]!;
		if (escape) {
			buf.push(ch);
			escape = false;
			i++;
			continue;
		}
		if (ch === "\\") {
			escape = true;
			i++;
			continue;
		}
		if (ch === quote) {
			const trailing = text.slice(i + 1).trim();
			if (trailing)
				throw new FlowParseError(
					lineError(lineNo, "Unexpected trailing content"),
				);
			return buf.join("");
		}
		buf.push(ch);
		i++;
	}
	throw new FlowParseError(lineError(lineNo, "Unclosed quoted label"));
}

function splitOnToken(text: string, token: string): string[] {
	const parts: string[] = [];
	let buf: string[] = [];
	let inSingle = false;
	let inDouble = false;
	let escape = false;
	let i = 0;

	while (i < text.length) {
		if (!inSingle && !inDouble && text.startsWith(token, i)) {
			parts.push(buf.join("").trim());
			buf = [];
			i += token.length;
			continue;
		}
		const ch = text[i]!;
		if (escape) escape = false;
		else if (ch === "\\" && (inSingle || inDouble)) escape = true;
		else if (ch === "'" && !inDouble) inSingle = !inSingle;
		else if (ch === '"' && !inSingle) inDouble = !inDouble;
		buf.push(ch);
		i++;
	}
	if (inSingle || inDouble)
		throw new FlowParseError("Unclosed string in statement");
	parts.push(buf.join("").trim());
	return parts;
}

function splitUnquotedOnce(
	text: string,
	token: string,
): [string, string | undefined] {
	let inSingle = false;
	let inDouble = false;
	let escape = false;
	for (let idx = 0; idx < text.length; idx++) {
		const ch = text[idx]!;
		if (escape) {
			escape = false;
			continue;
		}
		if (ch === "\\" && (inSingle || inDouble)) {
			escape = true;
			continue;
		}
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (ch === token && !inSingle && !inDouble) {
			return [text.slice(0, idx).trim(), text.slice(idx + 1).trim()];
		}
	}
	return [text.trim(), undefined];
}

function addNode(
	nodes: Map<string, NodeDef>,
	nodeId: string,
	label: string | undefined,
	explicit: boolean,
	lineNo: number,
): FlowNode {
	const effectiveLabel = label ?? nodeId;
	const labelNorm = effectiveLabel.trim().toLowerCase();
	if (!effectiveLabel)
		throw new FlowParseError(lineError(lineNo, "Node label cannot be empty"));

	let kind: FlowNodeKind = "task";
	if (labelNorm === "begin") kind = "begin";
	else if (labelNorm === "end") kind = "end";

	const node: FlowNode = { id: nodeId, label: effectiveLabel, kind };
	const existing = nodes.get(nodeId);

	if (!existing) {
		nodes.set(nodeId, { node, explicit });
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
		nodes.set(nodeId, { node, explicit: true });
		return node;
	}

	throw new FlowParseError(
		lineError(lineNo, `Conflicting definition for node "${nodeId}"`),
	);
}

function inferDecisionNodes(
	nodes: Record<string, FlowNode>,
	outgoing: Record<string, FlowEdge[]>,
): Record<string, FlowNode> {
	const updated: Record<string, FlowNode> = {};
	for (const [nodeId, node] of Object.entries(nodes)) {
		let kind = node.kind;
		if (kind === "task" && (outgoing[nodeId]?.length ?? 0) > 1)
			kind = "decision";
		updated[nodeId] =
			kind !== node.kind ? { id: node.id, label: node.label, kind } : node;
	}
	return updated;
}

function lineError(lineNo: number, message: string): string {
	return `Line ${lineNo}: ${message}`;
}

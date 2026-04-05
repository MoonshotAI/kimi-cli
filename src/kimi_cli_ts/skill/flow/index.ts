/**
 * Flow graph types and validation — corresponds to Python skill/flow/__init__.py
 */

export type FlowNodeKind = "begin" | "end" | "task" | "decision";

export class FlowError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FlowError";
	}
}

export class FlowParseError extends FlowError {
	constructor(message: string) {
		super(message);
		this.name = "FlowParseError";
	}
}

export class FlowValidationError extends FlowError {
	constructor(message: string) {
		super(message);
		this.name = "FlowValidationError";
	}
}

export interface FlowNode {
	readonly id: string;
	readonly label: string;
	readonly kind: FlowNodeKind;
}

export interface FlowEdge {
	readonly src: string;
	readonly dst: string;
	readonly label: string | undefined;
}

export interface Flow {
	readonly nodes: Record<string, FlowNode>;
	readonly outgoing: Record<string, FlowEdge[]>;
	readonly beginId: string;
	readonly endId: string;
}

const CHOICE_RE = /<choice>([^<]*)<\/choice>/g;

export function parseChoice(text: string): string | undefined {
	const matches = [...(text || "").matchAll(CHOICE_RE)];
	if (matches.length === 0) return undefined;
	return matches[matches.length - 1]![1]!.trim();
}

export function validateFlow(
	nodes: Record<string, FlowNode>,
	outgoing: Record<string, FlowEdge[]>,
): [string, string] {
	const beginIds = Object.values(nodes)
		.filter((n) => n.kind === "begin")
		.map((n) => n.id);
	const endIds = Object.values(nodes)
		.filter((n) => n.kind === "end")
		.map((n) => n.id);

	if (beginIds.length !== 1) {
		throw new FlowValidationError(
			`Expected exactly one BEGIN node, found ${beginIds.length}`,
		);
	}
	if (endIds.length !== 1) {
		throw new FlowValidationError(
			`Expected exactly one END node, found ${endIds.length}`,
		);
	}

	const beginId = beginIds[0]!;
	const endId = endIds[0]!;

	// BFS reachability
	const reachable = new Set<string>();
	const queue = [beginId];
	while (queue.length > 0) {
		const nodeId = queue.pop()!;
		if (reachable.has(nodeId)) continue;
		reachable.add(nodeId);
		for (const edge of outgoing[nodeId] ?? []) {
			if (!reachable.has(edge.dst)) queue.push(edge.dst);
		}
	}

	// Validate decision nodes have labeled, unique edges
	for (const node of Object.values(nodes)) {
		if (!reachable.has(node.id)) continue;
		const edges = outgoing[node.id] ?? [];
		if (edges.length <= 1) continue;
		const labels: string[] = [];
		for (const edge of edges) {
			if (!edge.label?.trim()) {
				throw new FlowValidationError(
					`Node "${node.id}" has an unlabeled edge`,
				);
			}
			labels.push(edge.label);
		}
		if (new Set(labels).size !== labels.length) {
			throw new FlowValidationError(
				`Node "${node.id}" has duplicate edge labels`,
			);
		}
	}

	if (!reachable.has(endId)) {
		throw new FlowValidationError("END node is not reachable from BEGIN");
	}

	return [beginId, endId];
}

/**
 * AskUserQuestion tool — ask the user structured questions.
 * Corresponds to Python tools/ask_user/__init__.py
 *
 * Uses Wire to send QuestionRequest → UI shows panel → user answers → resolves.
 */

import { z } from "zod/v4";
import { randomUUID } from "node:crypto";
import { CallableTool } from "../base.ts";
import type { ToolContext, ToolResult } from "../types.ts";
import { ToolOk, ToolError } from "../types.ts";
import { wireSend, wireMsg, getWireOrNull } from "../../soul/index.ts";
import { getCurrentToolCallOrNull } from "../../soul/toolset.ts";
import {
	PendingQuestionRequest,
	QuestionNotSupported,
} from "../../wire/types.ts";

// Global registry of pending question requests (keyed by request ID).
// The tool creates and stores here; the UI resolves by ID.
const _pendingQuestions = new Map<string, PendingQuestionRequest>();

/** Register a pending question (used by ctx.askUser wiring in wireToolContext). */
export function registerPendingQuestion(
	requestId: string,
	pending: PendingQuestionRequest,
): void {
	_pendingQuestions.set(requestId, pending);
}

/** Resolve a pending question request by ID. Called from the UI layer. */
export function resolveQuestionRequest(
	requestId: string,
	answers: Record<string, string>,
): void {
	const pending = _pendingQuestions.get(requestId);
	if (pending) {
		pending.resolve(answers);
		_pendingQuestions.delete(requestId);
	}
}

/** Reject a pending question request by ID (e.g., user cancelled). */
export function rejectQuestionRequest(requestId: string): void {
	const pending = _pendingQuestions.get(requestId);
	if (pending) {
		pending.setException(new QuestionNotSupported());
		_pendingQuestions.delete(requestId);
	}
}

const DESCRIPTION = `Use this tool when you need to ask the user questions with structured options during execution. This allows you to:
1. Collect user preferences or requirements before proceeding
2. Resolve ambiguous or underspecified instructions
3. Let the user decide between implementation approaches as you work
4. Present concrete options when multiple valid directions exist

**When NOT to use:**
- When you can infer the answer from context — be decisive and proceed
- Trivial decisions that don't materially affect the outcome

**Usage notes:**
- Users always have an "Other" option for custom input
- Use multi_select to allow multiple answers
- Keep option labels concise (1-5 words)
- Each question should have 2-4 meaningful, distinct options`;

const QuestionOptionSchema = z.object({
	label: z
		.string()
		.describe(
			"Concise display text (1-5 words). If recommended, append '(Recommended)'.",
		),
	description: z
		.string()
		.default("")
		.describe("Brief explanation of trade-offs or implications."),
});

const QuestionSchema = z.object({
	question: z
		.string()
		.describe("A specific, actionable question. End with '?'."),
	header: z
		.string()
		.default("")
		.describe("Short category tag (max 12 chars, e.g. 'Auth', 'Style')."),
	options: z
		.array(QuestionOptionSchema)
		.min(2)
		.max(4)
		.describe("2-4 meaningful, distinct options."),
	multi_select: z
		.boolean()
		.default(false)
		.describe("Whether the user can select multiple options."),
});

const ParamsSchema = z.object({
	questions: z
		.array(QuestionSchema)
		.min(1)
		.max(4)
		.describe("The questions to ask the user (1-4 questions)."),
});

type Params = z.infer<typeof ParamsSchema>;

export class AskUserQuestion extends CallableTool<typeof ParamsSchema> {
	readonly name = "AskUserQuestion";
	readonly description = DESCRIPTION;
	readonly schema = ParamsSchema;

	private _isYolo?: () => boolean;

	/** Late-bind yolo checker so we can auto-dismiss in non-interactive mode. */
	bindApproval(isYolo: () => boolean): void {
		this._isYolo = isYolo;
	}

	async execute(params: Params, ctx: ToolContext): Promise<ToolResult> {
		// Auto-dismiss in yolo mode (matches Python)
		if (this._isYolo?.()) {
			return ToolOk(
				'{"answers": {}, "note": "Running in non-interactive (yolo) mode. Make your own decision."}',
				"Non-interactive mode, auto-dismissed.",
			);
		}

		const wire = getWireOrNull();
		if (!wire) {
			// No Wire context (tests, non-interactive) — auto-select first option
			const answers: Record<string, string> = {};
			for (const q of params.questions) {
				answers[q.question] = q.options[0]?.label ?? "No answer";
			}
			return ToolOk(
				JSON.stringify({ answers }, null, 2),
				"Auto-selected (no interactive Wire).",
			);
		}

		const toolCall = getCurrentToolCallOrNull();
		if (!toolCall) {
			// No tool call context — auto-select first option
			const answers: Record<string, string> = {};
			for (const q of params.questions) {
				answers[q.question] = q.options[0]?.label ?? "No answer";
			}
			return ToolOk(
				JSON.stringify({ answers }, null, 2),
				"Auto-selected (no tool call context).",
			);
		}

		// Build question items matching Python's QuestionItem structure
		const questions = params.questions.map((q) => ({
			question: q.question,
			header: q.header,
			options: q.options.map((o) => ({
				label: o.label,
				description: o.description,
			})),
			multi_select: q.multi_select,
			body: "",
			other_label: "",
			other_description: "",
		}));

		// Create pending request with async resolution (matches Python's asyncio.Future pattern)
		const requestData = {
			id: randomUUID(),
			tool_call_id: toolCall.id,
			questions,
		};
		const pending = new PendingQuestionRequest(requestData);
		_pendingQuestions.set(requestData.id, pending);

		// Send through Wire → UI loop receives → shows QuestionPanel
		wireSend(wireMsg("QuestionRequest", requestData));

		// Block until user answers (future resolves when UI calls resolve())
		try {
			const answers = await pending.wait();
			_pendingQuestions.delete(requestData.id);
			return ToolOk(
				JSON.stringify({ answers }, null, 2),
				"User responses collected.",
			);
		} catch (err) {
			_pendingQuestions.delete(requestData.id);
			if (err instanceof QuestionNotSupported) {
				return ToolError(
					"The connected client does not support interactive questions. " +
						"Do NOT call this tool again. " +
						"Ask the user directly in your text response instead.",
				);
			}
			return ToolError(
				`Failed to get user response: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}

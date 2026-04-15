/**
 * QuestionRuntime — host-injected interface for AskUserQuestion (§9-F).
 *
 * Same architectural pattern as ApprovalRuntime: kimi-core defines the
 * interface; the host (TUI / CLI / SDK consumer) provides the real
 * implementation that wires through the UI layer. kimi-core never
 * renders UI — it only marshals the question → answer lifecycle.
 *
 * The `question.ask` ReverseRpcMethod (already declared in
 * wire-protocol/types.ts) is the wire-level vehicle; this interface
 * is the in-process contract consumed by `AskUserQuestionTool`.
 */

// ── Request / Response types ─────────────────────────────────────────

export interface QuestionOption {
  readonly label: string;
  readonly description?: string | undefined;
}

export interface QuestionItem {
  readonly question: string;
  readonly header?: string | undefined;
  readonly options: readonly QuestionOption[];
  readonly multiSelect?: boolean | undefined;
}

export interface QuestionRequest {
  readonly toolCallId: string;
  readonly questions: readonly QuestionItem[];
  readonly signal: AbortSignal;
}

export interface QuestionResult {
  /** JSON-serialised answers map, or empty string if dismissed / skipped. */
  readonly answer: string;
}

// ── Interface ────────────────────────────────────────────────────────

/**
 * QuestionRuntime manages the "ask → await user → answer" lifecycle for
 * structured user questions. SoulPlus / host owns the instance;
 * AskUserQuestionTool consumes it.
 */
export interface QuestionRuntime {
  /**
   * Send a structured question to the user and await their answer.
   * The returned promise resolves when the user responds (or dismisses).
   * Implementations should honor the AbortSignal on the request.
   */
  askQuestion(req: QuestionRequest): Promise<QuestionResult>;
}

// ── Always-skip stub (yolo / non-interactive) ────────────────────────

/**
 * Stub used when no interactive UI is available or when the session
 * runs in non-interactive (yolo) mode. Every question is immediately
 * dismissed with an empty answer.
 */
export class AlwaysSkipQuestionRuntime implements QuestionRuntime {
  async askQuestion(_req: QuestionRequest): Promise<QuestionResult> {
    return { answer: '' };
  }
}

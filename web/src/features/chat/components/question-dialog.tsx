import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import type { LiveMessage } from "@/hooks/types";
import type { QuestionItem } from "@/hooks/wireTypes";

type QuestionDialogProps = {
  messages: LiveMessage[];
  onQuestionResponse?: (
    requestId: string,
    answers: Record<string, string>,
  ) => Promise<void>;
  pendingQuestionMap: Record<string, boolean>;
};

/**
 * Detect the pending question from messages.
 * Exported so chat.tsx can check if a question is active without duplicating logic.
 */
export function usePendingQuestion(messages: LiveMessage[]) {
  return useMemo(() => {
    for (const message of messages) {
      if (
        message.variant === "tool" &&
        message.toolCall?.question &&
        message.toolCall.state === "question-requested" &&
        !message.toolCall.question.submitted
      ) {
        return {
          message,
          question: message.toolCall.question,
          toolCall: message.toolCall,
        };
      }
    }
    return null;
  }, [messages]);
}

/**
 * QuestionDialog replaces the prompt composer when a question is pending.
 */
export function QuestionDialog({
  messages,
  onQuestionResponse,
  pendingQuestionMap,
}: QuestionDialogProps) {
  const pendingQuestion = usePendingQuestion(messages);

  const questions = pendingQuestion?.question.questions ?? [];
  const totalQuestions = questions.length;

  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [multiSelected, setMultiSelected] = useState<Set<number>>(new Set());
  const [otherText, setOtherText] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const otherInputRef = useRef<HTMLInputElement>(null);

  // Reset state when the pending question changes
  const questionId = pendingQuestion?.question.id;
  const prevQuestionIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (questionId !== prevQuestionIdRef.current) {
      prevQuestionIdRef.current = questionId;
      setCurrentQuestionIndex(0);
      setSelectedIndex(null);
      setMultiSelected(new Set());
      setOtherText("");
      setAnswers({});
    }
  }, [questionId]);

  const currentQuestion: QuestionItem | undefined =
    questions[currentQuestionIndex];
  const options = currentQuestion?.options ?? [];
  const isMultiSelect = currentQuestion?.multi_select ?? false;
  const otherIndex = options.length;

  const questionPending = questionId
    ? pendingQuestionMap[questionId] === true
    : false;
  const disableActions = !onQuestionResponse || questionPending;

  const getCurrentAnswer = useCallback((): string | null => {
    if (isMultiSelect) {
      const labels: string[] = [];
      for (const idx of multiSelected) {
        if (idx === otherIndex) {
          if (otherText.trim()) labels.push(otherText.trim());
        } else if (options[idx]) {
          labels.push(options[idx].label);
        }
      }
      return labels.length > 0 ? labels.join(", ") : null;
    }
    if (selectedIndex === null) return null;
    if (selectedIndex === otherIndex) {
      return otherText.trim() || null;
    }
    return options[selectedIndex]?.label ?? null;
  }, [isMultiSelect, multiSelected, selectedIndex, otherIndex, otherText, options]);

  const handleSubmitCurrent = useCallback(async () => {
    if (disableActions || !currentQuestion || !pendingQuestion) return;

    const answer = getCurrentAnswer();
    if (!answer) return;

    const newAnswers = {
      ...answers,
      [currentQuestion.question]: answer,
    };

    if (currentQuestionIndex < totalQuestions - 1) {
      setAnswers(newAnswers);
      setCurrentQuestionIndex((prev) => prev + 1);
      setSelectedIndex(null);
      setMultiSelected(new Set());
      setOtherText("");
    } else {
      try {
        await onQuestionResponse!(pendingQuestion.question.id, newAnswers);
      } catch (error) {
        console.error("[QuestionDialog] Failed to respond", error);
      }
    }
  }, [
    disableActions,
    currentQuestion,
    pendingQuestion,
    getCurrentAnswer,
    answers,
    currentQuestionIndex,
    totalQuestions,
    onQuestionResponse,
  ]);

  const handleDismiss = useCallback(async () => {
    if (disableActions || !pendingQuestion) return;
    try {
      await onQuestionResponse!(pendingQuestion.question.id, {});
    } catch (error) {
      console.error("[QuestionDialog] Failed to dismiss", error);
    }
  }, [disableActions, pendingQuestion, onQuestionResponse]);

  const handleOptionClick = useCallback(
    (idx: number) => {
      if (disableActions) return;

      if (isMultiSelect) {
        setMultiSelected((prev) => {
          const next = new Set(prev);
          if (next.has(idx)) {
            next.delete(idx);
          } else {
            next.add(idx);
          }
          return next;
        });
        if (idx === otherIndex) {
          setTimeout(() => otherInputRef.current?.focus(), 0);
        }
      } else {
        setSelectedIndex(idx);
        if (idx === otherIndex) {
          setTimeout(() => otherInputRef.current?.focus(), 0);
        }
      }
    },
    [disableActions, isMultiSelect, otherIndex],
  );

  // Keyboard navigation
  useEffect(() => {
    if (!pendingQuestion || disableActions) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const el = document.activeElement;
      if (el) {
        const tag = el.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if ((el as HTMLElement).isContentEditable) return;
      }

      const totalOptions = options.length + 1;

      const num = Number.parseInt(event.key, 10);
      if (num >= 1 && num <= totalOptions) {
        event.preventDefault();
        handleOptionClick(num - 1);
        return;
      }

      if (event.key === "ArrowDown" || event.key === "j") {
        event.preventDefault();
        if (!isMultiSelect) {
          setSelectedIndex((prev) =>
            prev === null ? 0 : Math.min(prev + 1, totalOptions - 1),
          );
        }
      } else if (event.key === "ArrowUp" || event.key === "k") {
        event.preventDefault();
        if (!isMultiSelect) {
          setSelectedIndex((prev) =>
            prev === null ? totalOptions - 1 : Math.max(prev - 1, 0),
          );
        }
      } else if (event.key === "Enter") {
        event.preventDefault();
        handleSubmitCurrent();
      } else if (event.key === "Escape") {
        event.preventDefault();
        handleDismiss();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [pendingQuestion, disableActions, options.length, isMultiSelect, handleSubmitCurrent, handleOptionClick, handleDismiss]);

  if (!pendingQuestion || !currentQuestion) return null;

  const hasAnswer = getCurrentAnswer() !== null;
  const isLastQuestion = currentQuestionIndex >= totalQuestions - 1;

  return (
    <div className="w-full px-0 pb-0 pt-0 sm:px-3 sm:pb-3">
      <div
        className={cn(
          "relative w-full",
          "border border-border/60 rounded-xl",
          "bg-background",
          "shadow-sm",
          "overflow-hidden",
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-2.5 px-4 pt-3.5 pb-1 mb-1">
          <span className="font-semibold text-sm text-foreground">
            {currentQuestion.question}
          </span>
          {currentQuestion.header && (
            <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {currentQuestion.header}
            </span>
          )}
        </div>

        {/* Options */}
        <div className="flex flex-col px-4 py-2 gap-0.5">
          {options.map((option, idx) => {
            const isSelected = isMultiSelect
              ? multiSelected.has(idx)
              : selectedIndex === idx;
            const displayNumber = idx + 1;

            return (
              <button
                key={`${currentQuestion.question}-${option.label}`}
                type="button"
                disabled={disableActions}
                onClick={() => handleOptionClick(idx)}
                className={cn(
                  "flex items-start gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors cursor-pointer",
                  "hover:bg-muted/50",
                  isSelected && "bg-muted/70",
                  disableActions && "opacity-50 cursor-not-allowed",
                )}
              >
                {isMultiSelect ? (
                  <Checkbox
                    checked={isSelected}
                    className="mt-0.5 pointer-events-none"
                    tabIndex={-1}
                  />
                ) : (
                  <span className="flex-shrink-0 w-5 text-right text-muted-foreground font-mono text-sm">
                    {displayNumber}.
                  </span>
                )}
                <div className="flex flex-col min-w-0">
                  <span className="font-medium text-foreground">
                    {option.label}
                  </span>
                  {option.description && (
                    <span className="text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  )}
                </div>
              </button>
            );
          })}

          {/* "Other" — inline input */}
          <div
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors",
            )}
          >
            {isMultiSelect ? (
              <Checkbox
                checked={isMultiSelect ? multiSelected.has(otherIndex) : selectedIndex === otherIndex}
                onCheckedChange={() => handleOptionClick(otherIndex)}
                className="pointer-events-auto"
                tabIndex={-1}
              />
            ) : (
              <span className="flex-shrink-0 w-5 text-right text-muted-foreground font-mono text-sm">
                {options.length + 1}.
              </span>
            )}
            <input
              ref={otherInputRef}
              value={otherText}
              onChange={(e) => {
                setOtherText(e.target.value);
                if (!isMultiSelect) {
                  setSelectedIndex(otherIndex);
                } else if (!multiSelected.has(otherIndex)) {
                  setMultiSelected((prev) => new Set(prev).add(otherIndex));
                }
              }}
              onFocus={() => {
                if (!isMultiSelect) {
                  setSelectedIndex(otherIndex);
                } else if (!multiSelected.has(otherIndex)) {
                  setMultiSelected((prev) => new Set(prev).add(otherIndex));
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  handleSubmitCurrent();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                }
              }}
              placeholder="Type your answer..."
              className={cn(
                "flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/50",
                "border-0 outline-none ring-0 focus:ring-0 focus:outline-none",
                "py-0 h-auto",
                disableActions && "opacity-50 cursor-not-allowed",
              )}
              disabled={disableActions}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-4 px-4 py-2.5 mt-1">
          {totalQuestions > 1 && (
            <span className="text-xs text-muted-foreground/70 mr-auto">
              {currentQuestionIndex + 1} / {totalQuestions}
            </span>
          )}
          <button
            type="button"
            disabled={disableActions}
            onClick={handleDismiss}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors disabled:opacity-50 cursor-pointer"
          >
            Dismiss
            <Kbd className="text-[11px] opacity-70">esc</Kbd>
          </button>
          <button
            type="button"
            disabled={disableActions || !hasAnswer}
            onClick={handleSubmitCurrent}
            className={cn(
              "inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors",
              "disabled:opacity-30 disabled:pointer-events-none cursor-pointer",
            )}
          >
            {questionPending
              ? "Submitting..."
              : isLastQuestion
                ? "Submit"
                : "Next"}
            {!questionPending && <Kbd className="text-[11px]">↵</Kbd>}
          </button>
        </div>
      </div>
    </div>
  );
}

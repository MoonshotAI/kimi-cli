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
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [multiSelected, setMultiSelected] = useState<Set<number>>(new Set());
  const [otherText, setOtherText] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const otherInputRef = useRef<HTMLInputElement>(null);
  const savedSelectionsRef = useRef<
    Map<number, { selectedIndex: number; multiSelected: Set<number>; otherText: string }>
  >(new Map());

  // Reset state when the pending question changes
  const questionId = pendingQuestion?.question.id;
  const prevQuestionIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (questionId !== prevQuestionIdRef.current) {
      prevQuestionIdRef.current = questionId;
      setCurrentQuestionIndex(0);
      setSelectedIndex(0);
      setMultiSelected(new Set());
      setOtherText("");
      setAnswers({});
      savedSelectionsRef.current.clear();
    }
  }, [questionId]);

  const currentQuestion: QuestionItem | undefined =
    questions[currentQuestionIndex];
  const options = currentQuestion?.options ?? [];
  const isMultiSelect = currentQuestion?.multi_select ?? false;
  const otherIndex = options.length;

  // Auto-focus/blur Other input as selectedIndex moves in/out
  useEffect(() => {
    if (selectedIndex === otherIndex) {
      // In multi-select, only auto-focus if Other is checked
      if (!isMultiSelect || multiSelected.has(otherIndex)) {
        otherInputRef.current?.focus();
      }
    } else if (document.activeElement === otherInputRef.current) {
      otherInputRef.current?.blur();
    }
  }, [selectedIndex, otherIndex, isMultiSelect, multiSelected]);

  const questionPending = questionId
    ? pendingQuestionMap[questionId] === true
    : false;
  const disableActions = !onQuestionResponse || questionPending;

  const focusOtherInputAfterToggle = useCallback((wasSelectedBeforeToggle: boolean) => {
    if (wasSelectedBeforeToggle) {
      // Unchecking Other: blur to prevent onFocus re-adding
      if (document.activeElement === otherInputRef.current) {
        otherInputRef.current?.blur();
      }
    } else {
      // Checking Other: focus input for typing
      setTimeout(() => otherInputRef.current?.focus(), 0);
    }
  }, []);

  const getCurrentAnswer = useCallback((): string | null => {
    if (isMultiSelect) {
      const labels: string[] = [];
      for (const idx of Array.from(multiSelected).sort((a, b) => a - b)) {
        if (idx === otherIndex) {
          if (otherText.trim()) labels.push(otherText.trim());
        } else if (options[idx]) {
          labels.push(options[idx].label);
        }
      }
      return labels.length > 0 ? labels.join(", ") : null;
    }
    if (selectedIndex === otherIndex) {
      return otherText.trim() || null;
    }
    return options[selectedIndex]?.label ?? null;
  }, [isMultiSelect, multiSelected, selectedIndex, otherIndex, otherText, options]);

  /** Restore selection state for a given question index. */
  const restoreForQuestion = useCallback(
    (index: number) => {
      const saved = savedSelectionsRef.current.get(index);
      if (saved) {
        setSelectedIndex(saved.selectedIndex);
        setMultiSelected(saved.multiSelected);
        setOtherText(saved.otherText);
        return;
      }
      // Fall back to answers dict — find which option was submitted
      const targetQuestion = questions[index];
      if (targetQuestion) {
        const prevAnswer = answers[targetQuestion.question];
        if (prevAnswer) {
          if (targetQuestion.multi_select) {
            const answerLabels = prevAnswer.split(", ").map((s) => s.trim());
            const knownLabels = new Set(targetQuestion.options.map((o) => o.label));
            const selected = new Set<number>();
            targetQuestion.options.forEach((o, i) => {
              if (answerLabels.includes(o.label)) {
                selected.add(i);
              }
            });
            // Unmatched labels = Other text
            const otherParts = answerLabels.filter((l) => !knownLabels.has(l));
            if (otherParts.length > 0) {
              selected.add(targetQuestion.options.length);
              setOtherText(otherParts.join(", "));
            } else {
              setOtherText("");
            }
            setMultiSelected(selected);
            setSelectedIndex(selected.size > 0 ? Math.min(...selected) : 0);
          } else {
            const foundIdx = targetQuestion.options.findIndex(
              (o) => o.label === prevAnswer,
            );
            if (foundIdx >= 0) {
              setSelectedIndex(foundIdx);
              setOtherText("");
            } else {
              // Answer was Other text
              setSelectedIndex(targetQuestion.options.length);
              setOtherText(prevAnswer);
            }
            setMultiSelected(new Set());
          }
          return;
        }
      }
      // Brand new question — default to first option
      setSelectedIndex(0);
      setMultiSelected(new Set());
      setOtherText("");
    },
    [questions, answers],
  );

  /** Core advance logic: save state, record answer, advance or submit all. */
  const advanceWithAnswer = useCallback(
    async (answer: string) => {
      if (disableActions || !currentQuestion || !pendingQuestion) return;

      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }

      const newAnswers = {
        ...answers,
        [currentQuestion.question]: answer,
      };
      savedSelectionsRef.current.delete(currentQuestionIndex);
      // Keep local state in sync immediately, even if the final async submit fails.
      setAnswers(newAnswers);

      const allAnswered = questions.every((q) => q.question in newAnswers);
      if (allAnswered) {
        try {
          await onQuestionResponse!(pendingQuestion.question.id, newAnswers);
        } catch (error) {
          console.error("[QuestionDialog] Failed to respond", error);
        }
      } else {
        for (let offset = 1; offset <= totalQuestions; offset++) {
          const idx = (currentQuestionIndex + offset) % totalQuestions;
          if (!(questions[idx].question in newAnswers)) {
            setCurrentQuestionIndex(idx);
            restoreForQuestion(idx);
            break;
          }
        }
      }
    },
    [
      disableActions,
      currentQuestion,
      pendingQuestion,
      answers,
      questions,
      currentQuestionIndex,
      totalQuestions,
      onQuestionResponse,
      restoreForQuestion,
    ],
  );

  const handleSubmitCurrent = useCallback(async () => {
    const answer = getCurrentAnswer();
    if (!answer) return;
    await advanceWithAnswer(answer);
  }, [getCurrentAnswer, advanceWithAnswer]);

  const handleDismiss = useCallback(async () => {
    if (disableActions || !pendingQuestion) return;
    try {
      await onQuestionResponse!(pendingQuestion.question.id, {});
    } catch (error) {
      console.error("[QuestionDialog] Failed to dismiss", error);
    }
  }, [disableActions, pendingQuestion, onQuestionResponse]);

  const handleTabClick = useCallback(
    (index: number) => {
      if (disableActions || index === currentQuestionIndex) return;
      // Save current cursor state
      savedSelectionsRef.current.set(currentQuestionIndex, {
        selectedIndex,
        multiSelected,
        otherText,
      });
      setCurrentQuestionIndex(index);
      restoreForQuestion(index);
    },
    [disableActions, currentQuestionIndex, selectedIndex, multiSelected, otherText, restoreForQuestion],
  );

  const handleOptionClick = useCallback(
    (idx: number) => {
      if (disableActions) return;

      if (isMultiSelect) {
        const wasSelectedBeforeToggle = multiSelected.has(idx);
        setSelectedIndex(idx);
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
          focusOtherInputAfterToggle(wasSelectedBeforeToggle);
        }
      } else if (idx === otherIndex) {
        // Other option: focus input for typing
        setSelectedIndex(idx);
        setTimeout(() => otherInputRef.current?.focus(), 0);
      } else {
        // Single-select click on regular option: auto-confirm
        setSelectedIndex(idx);
        const clickedAnswer = options[idx]?.label;
        if (clickedAnswer) {
          advanceWithAnswer(clickedAnswer);
        }
      }
    },
    [disableActions, isMultiSelect, otherIndex, options, advanceWithAnswer, focusOtherInputAfterToggle, multiSelected],
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

      if (event.key === "ArrowLeft" && currentQuestionIndex > 0) {
        event.preventDefault();
        handleTabClick(currentQuestionIndex - 1);
      } else if (event.key === "ArrowRight" && currentQuestionIndex < totalQuestions - 1) {
        event.preventDefault();
        handleTabClick(currentQuestionIndex + 1);
      } else if (event.key === "ArrowDown" || event.key === "j") {
        event.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, totalOptions - 1));
      } else if (event.key === "ArrowUp" || event.key === "k") {
        event.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      } else if (event.key === " ") {
        event.preventDefault();
        if (isMultiSelect) {
          const wasSelectedBeforeToggle = multiSelected.has(selectedIndex);
          // Toggle checkbox at focused position
          setMultiSelected((prev) => {
            const next = new Set(prev);
            if (next.has(selectedIndex)) {
              next.delete(selectedIndex);
            } else {
              next.add(selectedIndex);
            }
            return next;
          });
          if (selectedIndex === otherIndex) {
            focusOtherInputAfterToggle(wasSelectedBeforeToggle);
          }
        } else {
          // Single-select: confirm like Enter
          handleSubmitCurrent();
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
  }, [pendingQuestion, disableActions, options.length, isMultiSelect, selectedIndex, otherIndex, handleSubmitCurrent, handleOptionClick, handleDismiss, handleTabClick, currentQuestionIndex, totalQuestions, multiSelected, focusOtherInputAfterToggle]);

  if (!(pendingQuestion && currentQuestion)) return null;

  const hasAnswer = getCurrentAnswer() !== null;
  // Would submitting the current answer complete all questions?
  const allQuestionsAnswered =
    hasAnswer &&
    questions.every(
      (q) => q.question in answers || q.question === currentQuestion.question,
    );

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
        {/* Tab bar for multi-question */}
        {totalQuestions > 1 && (
          <div className="flex items-center gap-1.5 px-4 pt-3 pb-1">
            {questions.map((q, i) => {
              const label = q.header || `Q${i + 1}`;
              const isAnswered = q.question in answers;
              const isActive = i === currentQuestionIndex;
              return (
                <button
                  key={`tab-${q.question}`}
                  type="button"
                  disabled={disableActions}
                  onClick={() => handleTabClick(i)}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer",
                    isActive && "bg-primary text-primary-foreground",
                    isAnswered && !isActive && "bg-secondary text-secondary-foreground",
                    !(isActive || isAnswered) && "border border-border/60 text-muted-foreground hover:bg-muted/50",
                    disableActions && "opacity-50 cursor-not-allowed",
                  )}
                >
                  <span className="text-[10px]">
                    {isActive ? "\u25cf" : isAnswered ? "\u2713" : "\u25cb"}
                  </span>
                  {label}
                </button>
              );
            })}
          </div>
        )}

        {/* Question text */}
        <div className="flex items-center gap-2.5 px-4 pt-2 pb-1 mb-1">
          <span className="font-semibold text-sm text-foreground">
            {currentQuestion.question}
          </span>
          {totalQuestions === 1 && currentQuestion.header && (
            <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {currentQuestion.header}
            </span>
          )}
        </div>

        {/* Options */}
        <div className="flex flex-col px-4 py-2 gap-0.5">
          {options.map((option, idx) => {
            const isFocused = selectedIndex === idx;
            const isChecked = isMultiSelect && multiSelected.has(idx);
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
                  isChecked && "bg-primary/[0.08]",
                  isFocused && !isChecked && "bg-muted/70",
                  isFocused && isChecked && "ring-1 ring-inset ring-primary/20",
                  disableActions && "opacity-50 cursor-not-allowed",
                )}
              >
                {isMultiSelect ? (
                  <Checkbox
                    checked={isChecked}
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
              isMultiSelect && multiSelected.has(otherIndex) && "bg-primary/[0.08]",
              selectedIndex === otherIndex && !(isMultiSelect && multiSelected.has(otherIndex)) && "bg-muted/70",
              selectedIndex === otherIndex && isMultiSelect && multiSelected.has(otherIndex) && "ring-1 ring-inset ring-primary/20",
            )}
          >
            {isMultiSelect ? (
              <Checkbox
                checked={multiSelected.has(otherIndex)}
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
                setSelectedIndex(otherIndex);
                if (isMultiSelect && !multiSelected.has(otherIndex)) {
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
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSelectedIndex(Math.max(otherIndex - 1, 0));
                } else if (e.key === "ArrowDown") {
                  // Already at last position — no-op but prevent default
                  e.preventDefault();
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
        <div className="flex items-center gap-4 px-4 py-2.5 mt-1">
          {/* Keyboard hints */}
          <div className="flex items-center gap-3 mr-auto text-muted-foreground/40 text-[11px]">
            <span className="inline-flex items-center gap-1">
              <Kbd className="text-[10px] opacity-60">↑↓</Kbd>
              select
            </span>
            {totalQuestions > 1 && (
              <span className="inline-flex items-center gap-1">
                <Kbd className="text-[10px] opacity-60">←→</Kbd>
                switch
              </span>
            )}
            {isMultiSelect ? (
              <>
                <span className="inline-flex items-center gap-1">
                  <Kbd className="text-[10px] opacity-60">space</Kbd>
                  toggle
                </span>
                <span className="inline-flex items-center gap-1">
                  <Kbd className="text-[10px] opacity-60">↵</Kbd>
                  confirm
                </span>
              </>
            ) : (
              <span className="inline-flex items-center gap-1">
                <Kbd className="text-[10px] opacity-60">space/↵</Kbd>
                confirm
              </span>
            )}
          </div>

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
              : allQuestionsAnswered
                ? "Submit"
                : "Next"}
            {!questionPending && <Kbd className="text-[11px]">↵</Kbd>}
          </button>
        </div>
      </div>
    </div>
  );
}

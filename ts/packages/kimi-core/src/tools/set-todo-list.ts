/**
 * SetTodoListTool — structured TODO list management tool (Slice 3.6).
 *
 * Ports Python `kimi_cli/tools/todo/__init__.py`. The LLM uses this tool
 * to maintain a visible plan of sub-tasks during plan-mode workflows and
 * multi-step operations. A single tool serves both reads and writes:
 *
 *   - `execute({ todos: [...] })` — replace the full list
 *   - `execute({ todos: [] })`    — clear the list
 *   - `execute({})`               — query current list (no mutation)
 *
 * Storage: TS 3.6 keeps todos in an injected {@link TodoStore} so the
 * tool has no opinion on where they live. The default
 * {@link InMemoryTodoStore} is process-local; hosts that want durable
 * storage (session state / file) can supply their own implementation.
 * Python persists via `session.state.todos`; TS defers that until a
 * storage integration slice lands because ContextState has no
 * first-class todo field.
 */

import { z } from 'zod';

import type { ToolResult, ToolUpdate, ToolMetadata } from '../soul/types.js';
import type { BuiltinTool } from './types.js';

// ── TODO state shape ─────────────────────────────────────────────────

export type TodoStatus = 'pending' | 'in_progress' | 'done';

export interface TodoItem {
  readonly title: string;
  readonly status: TodoStatus;
}

// ── Schema ───────────────────────────────────────────────────────────

const TodoItemSchema = z.object({
  title: z.string().min(1).describe('Short, actionable title for the todo.'),
  status: z.enum(['pending', 'in_progress', 'done']).describe('Current status of the todo.'),
});

export interface SetTodoListInput {
  todos?: Array<{ title: string; status: TodoStatus }> | undefined;
}

export const SetTodoListInputSchema: z.ZodType<SetTodoListInput> = z.object({
  todos: z
    .array(TodoItemSchema)
    .optional()
    .describe(
      'The updated todo list. Omit to read the current todo list without making changes. Pass an empty array to clear the list.',
    ),
});

// ── Storage ───────────────────────────────────────────────────────────

export interface TodoStore {
  getTodos(): readonly TodoItem[];
  setTodos(todos: readonly TodoItem[]): void;
}

/**
 * Default in-memory TodoStore. Process-local — does NOT survive session
 * resume / crash recovery. Hosts that need durability should inject a
 * custom implementation backed by session state or a key-value store.
 */
export class InMemoryTodoStore implements TodoStore {
  private todos: readonly TodoItem[] = [];

  getTodos(): readonly TodoItem[] {
    return this.todos;
  }

  setTodos(todos: readonly TodoItem[]): void {
    // Defensive copy so mutations to the caller's array cannot leak
    // into the store after the fact.
    this.todos = todos.map((t) => ({ title: t.title, status: t.status }));
  }
}

// ── Tool description ─────────────────────────────────────────────────

const DESCRIPTION = `Use this tool to maintain a structured TODO list as you work through a multi-step task. This is especially useful in plan mode and for long-running investigations.

**When to use:**
- Multi-step tasks that span several tool calls
- Tracking investigation progress across a large codebase search
- Planning a sequence of edits before making them

**When NOT to use:**
- Single-shot answers that complete in one or two tool calls
- Trivial requests where tracking adds no clarity

**How to use:**
- Call with \`todos: [...]\` to replace the full list. Statuses: pending / in_progress / done.
- Call with no arguments to retrieve the current list without changing it.
- Call with \`todos: []\` to clear the list.
- Keep titles short and actionable (e.g. "Read session-control.ts", "Add planMode flag to TurnManager").
- Update statuses as you make progress — mark one item in_progress at a time.`;

// ── Implementation ───────────────────────────────────────────────────

function renderTodoList(todos: readonly TodoItem[]): string {
  if (todos.length === 0) {
    return 'Todo list is empty.';
  }
  const lines = todos.map((t) => {
    const marker = statusMarker(t.status);
    return `  ${marker} ${t.title}`;
  });
  return ['Current todo list:', ...lines].join('\n');
}

function statusMarker(status: TodoStatus): string {
  switch (status) {
    case 'pending':
      return '[pending]';
    case 'in_progress':
      return '[in_progress]';
    case 'done':
      return '[completed]';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export class SetTodoListTool implements BuiltinTool<SetTodoListInput, TodoItem[]> {
  readonly name = 'SetTodoList' as const;
  readonly metadata: ToolMetadata = { source: 'builtin' };
  readonly description: string = DESCRIPTION;
  readonly inputSchema: z.ZodType<SetTodoListInput> = SetTodoListInputSchema;

  constructor(private readonly store: TodoStore) {}

  getActivityDescription(args: SetTodoListInput): string {
    if (args.todos === undefined) return 'Reading todo list';
    if (args.todos.length === 0) return 'Clearing todo list';
    return 'Updating todo list';
  }

  async execute(
    _toolCallId: string,
    args: SetTodoListInput,
    _signal: AbortSignal,
    _onUpdate?: (update: ToolUpdate) => void,
  ): Promise<ToolResult<TodoItem[]>> {
    // Query mode — return the current list without mutation.
    if (args.todos === undefined) {
      const current = this.store.getTodos();
      return {
        isError: false,
        content: renderTodoList(current),
        output: [...current],
      };
    }

    // Write mode — replace the full list and return the new state.
    this.store.setTodos(args.todos);
    const stored = this.store.getTodos();
    const content =
      stored.length === 0 ? 'Todo list cleared.' : `Todo list updated.\n${renderTodoList(stored)}`;
    return {
      isError: false,
      content,
      output: [...stored],
    };
  }
}

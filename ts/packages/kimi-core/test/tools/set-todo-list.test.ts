/**
 * Covers: SetTodoListTool + InMemoryTodoStore (Slice 3.6).
 *
 * Pins:
 *   - tool name / schema shape
 *   - query mode (no `todos`) returns current list without mutation
 *   - write mode (non-empty `todos`) replaces the list and returns it
 *   - clear mode (empty `todos`) empties the list
 *   - defensive copy — mutating the input after a write does not alter the store
 */

import { describe, expect, it } from 'vitest';

import {
  InMemoryTodoStore,
  SetTodoListTool,
  type TodoItem,
} from '../../src/tools/set-todo-list.js';

describe('InMemoryTodoStore', () => {
  it('starts empty', () => {
    const store = new InMemoryTodoStore();
    expect(store.getTodos()).toEqual([]);
  });

  it('setTodos replaces the list', () => {
    const store = new InMemoryTodoStore();
    store.setTodos([{ title: 'a', status: 'pending' }]);
    expect(store.getTodos()).toEqual([{ title: 'a', status: 'pending' }]);
    store.setTodos([{ title: 'b', status: 'done' }]);
    expect(store.getTodos()).toEqual([{ title: 'b', status: 'done' }]);
  });

  it('setTodos defensively copies its input', () => {
    const store = new InMemoryTodoStore();
    const initial: TodoItem[] = [{ title: 'alpha', status: 'pending' }];
    store.setTodos(initial);
    // Mutating the caller's array must not leak into the store.
    initial[0] = { title: 'leaked', status: 'done' };
    expect(store.getTodos()).toEqual([{ title: 'alpha', status: 'pending' }]);
  });
});

describe('SetTodoListTool', () => {
  const makeTool = (): { tool: SetTodoListTool; store: InMemoryTodoStore } => {
    const store = new InMemoryTodoStore();
    const tool = new SetTodoListTool(store);
    return { tool, store };
  };

  it('has name "SetTodoList" and a non-empty description', () => {
    const { tool } = makeTool();
    expect(tool.name).toBe('SetTodoList');
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it('schema rejects invalid status', () => {
    const { tool } = makeTool();
    const result = tool.inputSchema.safeParse({
      todos: [{ title: 'x', status: 'wip' }],
    });
    expect(result.success).toBe(false);
  });

  it('query mode returns current list without mutation', async () => {
    const { tool, store } = makeTool();
    store.setTodos([{ title: 'existing', status: 'in_progress' }]);

    const result = await tool.execute('call_1', {}, new AbortController().signal);
    expect(result.isError).toBe(false);
    expect(result.output).toEqual([{ title: 'existing', status: 'in_progress' }]);
    // Store unchanged
    expect(store.getTodos()).toEqual([{ title: 'existing', status: 'in_progress' }]);
  });

  it('write mode replaces the list', async () => {
    const { tool, store } = makeTool();
    const result = await tool.execute(
      'call_1',
      {
        todos: [
          { title: 'first', status: 'pending' },
          { title: 'second', status: 'in_progress' },
        ],
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toEqual([
      { title: 'first', status: 'pending' },
      { title: 'second', status: 'in_progress' },
    ]);
    expect(store.getTodos()).toEqual([
      { title: 'first', status: 'pending' },
      { title: 'second', status: 'in_progress' },
    ]);
    expect(typeof result.content).toBe('string');
    expect(result.content).toContain('Todo list updated');
  });

  it('clear mode empties the list', async () => {
    const { tool, store } = makeTool();
    store.setTodos([{ title: 'x', status: 'pending' }]);

    const result = await tool.execute('call_1', { todos: [] }, new AbortController().signal);
    expect(result.isError).toBe(false);
    expect(result.output).toEqual([]);
    expect(store.getTodos()).toEqual([]);
    expect(result.content).toContain('Todo list cleared');
  });

  it('getActivityDescription reflects the mode', () => {
    const { tool } = makeTool();
    expect(tool.getActivityDescription({})).toBe('Reading todo list');
    expect(tool.getActivityDescription({ todos: [] })).toBe('Clearing todo list');
    expect(tool.getActivityDescription({ todos: [{ title: 'x', status: 'pending' }] })).toBe(
      'Updating todo list',
    );
  });
});

/**
 * TodoPanel — live-updating TODO list pinned above the input.
 *
 * Mounted as a dedicated `Container` slot between the activity pane
 * (spinners / thinking stream) and the queue / editor block. The host
 * calls {@link setTodos} whenever the LLM invokes the `SetTodoList`
 * tool; state survives across turns so the list stays visible until
 * explicitly cleared (`todos: []`), a new session starts, or `/clear`
 * is issued.
 */

import type { Component } from '@mariozechner/pi-tui';
import { truncateToWidth } from '@mariozechner/pi-tui';
import chalk from 'chalk';
import type { ColorPalette } from '../theme/colors.js';

export type TodoStatus = 'pending' | 'in_progress' | 'done';

export interface TodoItem {
  readonly title: string;
  readonly status: TodoStatus;
}

export class TodoPanelComponent implements Component {
  private todos: readonly TodoItem[] = [];
  private colors: ColorPalette;

  constructor(colors: ColorPalette) {
    this.colors = colors;
  }

  setTodos(todos: readonly TodoItem[]): void {
    this.todos = todos.map((t) => ({ title: t.title, status: t.status }));
  }

  getTodos(): readonly TodoItem[] {
    return this.todos;
  }

  clear(): void {
    this.todos = [];
  }

  isEmpty(): boolean {
    return this.todos.length === 0;
  }

  setColors(colors: ColorPalette): void {
    this.colors = colors;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.todos.length === 0) return [];
    const c = this.colors;
    const lines: string[] = [];

    lines.push(chalk.hex(c.border)('─'.repeat(width)));
    lines.push(chalk.hex(c.primary).bold(' Todo'));
    for (const todo of this.todos) {
      lines.push(renderRow(todo, c));
    }

    return lines.map((line) => truncateToWidth(line, width));
  }
}

function renderRow(todo: TodoItem, colors: ColorPalette): string {
  const marker = statusMarker(todo.status, colors);
  const titleStyled = styleTitle(todo.title, todo.status, colors);
  return `  ${marker} ${titleStyled}`;
}

function statusMarker(status: TodoStatus, colors: ColorPalette): string {
  switch (status) {
    case 'in_progress':
      return chalk.hex(colors.primary).bold('●');
    case 'done':
      return chalk.hex(colors.success)('✓');
    case 'pending':
      return chalk.hex(colors.textDim)('○');
  }
}

function styleTitle(title: string, status: TodoStatus, colors: ColorPalette): string {
  switch (status) {
    case 'in_progress':
      return chalk.hex(colors.text).bold(title);
    case 'done':
      return chalk.hex(colors.textDim).strikethrough(title);
    case 'pending':
      return chalk.hex(colors.text)(title);
  }
}

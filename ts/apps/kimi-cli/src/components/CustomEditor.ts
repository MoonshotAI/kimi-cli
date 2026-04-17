/**
 * Custom editor extending pi-tui Editor with app-level keybindings.
 */

import { Editor, type EditorTheme, type TUI, matchesKey, Key } from '@mariozechner/pi-tui';

export class CustomEditor extends Editor {
  public onEscape?: () => void;
  public onCtrlD?: () => void;
  public onCtrlC?: () => void;
  public onToggleToolExpand?: () => void;
  public onOpenExternalEditor?: () => void;
  public onCtrlS?: () => void;
  /**
   * Called when ↑ is pressed in an empty editor. Return `true` to consume
   * the key (e.g. recalled a queued message); return `false` to fall
   * through so pi-tui's built-in history navigation runs.
   */
  public onUpArrowEmpty?: () => boolean;
  public onShiftTab?: () => void;

  constructor(tui: TUI, theme: EditorTheme) {
    super(tui, theme);
  }

  override handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl('d'))) {
      if (this.getText().length === 0) {
        this.onCtrlD?.();
        return;
      }
    }

    if (matchesKey(data, Key.ctrl('c'))) {
      this.onCtrlC?.();
      return;
    }

    if (matchesKey(data, Key.ctrl('o'))) {
      this.onOpenExternalEditor?.();
      return;
    }

    if (matchesKey(data, Key.ctrl('t'))) {
      this.onToggleToolExpand?.();
      return;
    }

    if (matchesKey(data, Key.ctrl('s'))) {
      this.onCtrlS?.();
      return;
    }

    if (matchesKey(data, 'shift+tab')) {
      this.onShiftTab?.();
      return;
    }

    if (matchesKey(data, Key.up)) {
      if (this.getText().length === 0 && this.onUpArrowEmpty) {
        if (this.onUpArrowEmpty()) return;
        // fall through to super so Editor's built-in history navigation runs
      }
    }

    if (matchesKey(data, Key.escape)) {
      if (!this.isShowingAutocomplete()) {
        this.onEscape?.();
        return;
      }
    }

    super.handleInput(data);
  }
}

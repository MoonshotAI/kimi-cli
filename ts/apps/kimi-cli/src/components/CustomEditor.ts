/**
 * Custom editor extending pi-tui Editor with app-level keybindings.
 */

import { Editor, type EditorTheme, type TUI, matchesKey, Key } from '@mariozechner/pi-tui';

export class CustomEditor extends Editor {
  public onEscape?: () => void;
  public onCtrlD?: () => void;
  public onCtrlC?: () => void;
  public onToggleToolExpand?: () => void;

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
      this.onToggleToolExpand?.();
      return;
    }

    if (matchesKey(data, Key.escape)) {
      if (!this.isShowingAutocomplete()) {
        this.onEscape?.();
        return;
      }
    }

    if (matchesKey(data, Key.enter)) {
      if (!this.isShowingAutocomplete()) {
        const text = this.getText().trim();
        if (text.length > 0) {
          this.onSubmit?.(text);
          this.setText('');
          return;
        }
        return;
      }
    }

    super.handleInput(data);
  }
}

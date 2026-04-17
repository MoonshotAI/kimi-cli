import { Text } from '@mariozechner/pi-tui';
import type { TUI } from '@mariozechner/pi-tui';

const MOON_PHASES = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
const MOON_INTERVAL = 120;

export class MoonLoader extends Text {
  private currentFrame = 0;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private ui: TUI;

  constructor(ui: TUI) {
    super('', 1, 0);
    this.ui = ui;
    this.start();
  }

  override render(width: number): string[] {
    return ['', ...super.render(width)];
  }

  start(): void {
    this.updateDisplay();
    this.intervalId = setInterval(() => {
      this.currentFrame = (this.currentFrame + 1) % MOON_PHASES.length;
      this.updateDisplay();
    }, MOON_INTERVAL);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private updateDisplay(): void {
    this.setText(MOON_PHASES[this.currentFrame]!);
    this.ui.requestRender();
  }
}

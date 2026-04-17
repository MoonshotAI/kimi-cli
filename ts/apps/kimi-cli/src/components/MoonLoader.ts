import { Text } from '@mariozechner/pi-tui';
import type { TUI } from '@mariozechner/pi-tui';

const MOON_PHASES = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
const MOON_INTERVAL = 120;

const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const BRAILLE_INTERVAL = 80;

export type SpinnerStyle = 'moon' | 'braille';

export class MoonLoader extends Text {
  private currentFrame = 0;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private ui: TUI;
  private frames: string[];
  private interval: number;
  private colorFn?: (s: string) => string;
  private label: string;

  constructor(ui: TUI, style: SpinnerStyle = 'moon', colorFn?: (s: string) => string, label: string = '') {
    super('', 1, 0);
    this.ui = ui;
    this.frames = style === 'moon' ? MOON_PHASES : BRAILLE_FRAMES;
    this.interval = style === 'moon' ? MOON_INTERVAL : BRAILLE_INTERVAL;
    this.colorFn = colorFn;
    this.label = label;
    this.start();
  }

  override render(width: number): string[] {
    return ['', ...super.render(width)];
  }

  start(): void {
    this.updateDisplay();
    this.intervalId = setInterval(() => {
      this.currentFrame = (this.currentFrame + 1) % this.frames.length;
      this.updateDisplay();
    }, this.interval);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private updateDisplay(): void {
    const frame = this.frames[this.currentFrame]!;
    const coloredFrame = this.colorFn ? this.colorFn(frame) : frame;
    this.setText(this.label ? `${coloredFrame} ${this.label}` : coloredFrame);
    this.ui.requestRender();
  }
}

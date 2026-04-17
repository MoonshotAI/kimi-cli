import { describe, it, expect, vi } from 'vitest';

import { HelpPanelComponent } from '../../src/components/HelpPanelComponent.js';
import { darkColors } from '../../src/theme/colors.js';
import type { SlashCommandDef } from '../../src/slash/registry.js';

function cmd(name: string, description: string, aliases: string[] = []): SlashCommandDef {
  return {
    name,
    aliases,
    description,
    mode: 'both',
    execute: async () => ({ type: 'ok' }),
  };
}

function strip(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('HelpPanelComponent', () => {
  it('renders keyboard shortcuts + slash commands sections', () => {
    const panel = new HelpPanelComponent({
      commands: [cmd('exit', 'Exit', ['quit', 'q'])],
      colors: darkColors,
      onClose: () => {},
    });
    const out = strip(panel.render(80).join('\n'));
    expect(out).toMatch(/help/);
    expect(out).toMatch(/Keyboard shortcuts/);
    expect(out).toMatch(/Shift-Tab/);
    expect(out).toMatch(/Ctrl-O/);
    expect(out).toMatch(/Slash commands/);
    expect(out).toMatch(/\/exit \(\/quit, \/q\)/);
    expect(out).toMatch(/Exit/);
  });

  it('sorts slash commands by name', () => {
    const panel = new HelpPanelComponent({
      commands: [cmd('zebra', 'Z'), cmd('alpha', 'A'), cmd('mango', 'M')],
      colors: darkColors,
      onClose: () => {},
    });
    const out = strip(panel.render(80).join('\n'));
    const alphaIdx = out.indexOf('/alpha');
    const mangoIdx = out.indexOf('/mango');
    const zebraIdx = out.indexOf('/zebra');
    expect(alphaIdx).toBeGreaterThan(-1);
    expect(alphaIdx).toBeLessThan(mangoIdx);
    expect(mangoIdx).toBeLessThan(zebraIdx);
  });

  it('Escape fires onClose', () => {
    const onClose = vi.fn();
    const panel = new HelpPanelComponent({
      commands: [],
      colors: darkColors,
      onClose,
    });
    panel.handleInput('\x1b'); // Esc
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('q / Enter also close the panel', () => {
    const onClose = vi.fn();
    const panel = new HelpPanelComponent({
      commands: [],
      colors: darkColors,
      onClose,
    });
    panel.handleInput('q');
    panel.handleInput('\r');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('clips to maxVisible with a "showing X-Y of Z" tail', () => {
    const many = Array.from({ length: 30 }, (_, i) => cmd(`cmd${String(i)}`, `Desc ${String(i)}`));
    const panel = new HelpPanelComponent({
      commands: many,
      colors: darkColors,
      onClose: () => {},
      maxVisible: 6,
    });
    const out = strip(panel.render(80).join('\n'));
    expect(out).toMatch(/showing 1-6 of/);
  });

  it('arrow keys shift the scroll window', () => {
    const many = Array.from({ length: 30 }, (_, i) => cmd(`cmd${String(i)}`, 'd'));
    const panel = new HelpPanelComponent({
      commands: many,
      colors: darkColors,
      onClose: () => {},
      maxVisible: 6,
    });
    panel.handleInput('\x1b[B'); // ↓
    panel.handleInput('\x1b[B'); // ↓
    const out = strip(panel.render(80).join('\n'));
    expect(out).toMatch(/showing 3-8 of/);
    panel.handleInput('\x1b[A'); // ↑
    const out2 = strip(panel.render(80).join('\n'));
    expect(out2).toMatch(/showing 2-7 of/);
  });
});

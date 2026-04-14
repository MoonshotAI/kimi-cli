/**
 * Style helper functions that apply theme-aware styling.
 *
 * These wrap chalk calls so components don't need to reference
 * color constants directly.
 */

import chalk from 'chalk';
import { getColorPalette } from './colors.js';
import type { ColorPalette } from './colors.js';

export interface ThemeStyles {
  colors: ColorPalette;

  /** Style a primary-colored string. */
  primary(text: string): string;
  /** Style a dimmed string. */
  dim(text: string): string;
  /** Style a muted (very faint) string. */
  muted(text: string): string;
  /** Style an error string. */
  error(text: string): string;
  /** Style a warning string. */
  warning(text: string): string;
  /** Style a success string. */
  success(text: string): string;
  /** Style a label (bold, dimmed). */
  label(text: string): string;
  /** Style a value (normal text). */
  value(text: string): string;
}

export function createThemeStyles(theme: 'dark' | 'light'): ThemeStyles {
  const colors = getColorPalette(theme);

  return {
    colors,
    primary: (text: string) => chalk.hex(colors.primary)(text),
    dim: (text: string) => chalk.hex(colors.textDim)(text),
    muted: (text: string) => chalk.hex(colors.textMuted)(text),
    error: (text: string) => chalk.hex(colors.error)(text),
    warning: (text: string) => chalk.hex(colors.warning)(text),
    success: (text: string) => chalk.hex(colors.success)(text),
    label: (text: string) => chalk.bold.hex(colors.textDim)(text),
    value: (text: string) => chalk.hex(colors.text)(text),
  };
}

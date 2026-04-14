/**
 * Base color definitions for dark and light themes.
 *
 * Each palette provides semantic color names consumed by UI components.
 * Colors are plain hex strings (or ANSI-compatible chalk color names)
 * that can be passed directly to chalk or Ink's `<Text color>`.
 */

export interface ColorPalette {
  // Branding
  primary: string;
  primaryDim: string;

  // Text
  text: string;
  textDim: string;
  textMuted: string;

  // Semantic
  success: string;
  warning: string;
  error: string;
  info: string;

  // UI elements
  border: string;
  prompt: string;
  spinner: string;

  // Roles
  user: string;
  assistant: string;
  thinking: string;
  toolCall: string;
  status: string;
}

export const darkColors: ColorPalette = {
  primary: '#5B9BF7',
  primaryDim: '#3D6FBF',

  text: '#E0E0E0',
  textDim: '#888888',
  textMuted: '#555555',

  success: '#4EC87E',
  warning: '#E8A838',
  error: '#E85454',
  info: '#5B9BF7',

  border: '#444444',
  prompt: '#5B9BF7',
  spinner: '#5B9BF7',

  user: '#4EC87E',
  assistant: '#E0E0E0',
  thinking: '#888888',
  toolCall: '#E8A838',
  status: '#888888',
};

export const lightColors: ColorPalette = {
  primary: '#2563EB',
  primaryDim: '#6B96E8',

  text: '#1A1A1A',
  textDim: '#666666',
  textMuted: '#999999',

  success: '#16A34A',
  warning: '#CA8A04',
  error: '#DC2626',
  info: '#2563EB',

  border: '#CCCCCC',
  prompt: '#2563EB',
  spinner: '#2563EB',

  user: '#16A34A',
  assistant: '#1A1A1A',
  thinking: '#666666',
  toolCall: '#CA8A04',
  status: '#666666',
};

export function getColorPalette(theme: 'dark' | 'light'): ColorPalette {
  return theme === 'dark' ? darkColors : lightColors;
}

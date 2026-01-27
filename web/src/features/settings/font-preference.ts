export type FontPreference = "iosevka" | "system";

const FONT_STORAGE_KEY = "kiwi:font";

export function getSavedFontPreference(): FontPreference | null {
  if (typeof window === "undefined") {
    return null;
  }
  const raw = window.localStorage.getItem(FONT_STORAGE_KEY);
  if (raw === "iosevka" || raw === "system") {
    return raw;
  }
  return null;
}

export function applyFontPreference(font: FontPreference): void {
  document.documentElement.dataset.font = font;
}

export function applySavedFontPreference(): void {
  const saved = getSavedFontPreference();
  if (!saved) {
    return;
  }
  applyFontPreference(saved);
}

export function saveFontPreference(font: FontPreference): void {
  window.localStorage.setItem(FONT_STORAGE_KEY, font);
  applyFontPreference(font);
}


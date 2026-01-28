import { v4 as uuidV4 } from "uuid";

// Declare the global __KIWI__ object injected by Electron
declare global {
  interface Window {
    __KIWI__?: {
      port?: number;
      isElectron?: boolean;
    };
  }
}

/**
 * Check if running in Electron environment.
 * Used for platform-specific UI adjustments (e.g., titlebar spacing on macOS).
 */
export function isElectron(): boolean {
  return window.__KIWI__?.isElectron === true;
}

/**
 * Check if running on macOS in Electron.
 * macOS uses hiddenInset titlebar style which requires special handling.
 */
export function isElectronMac(): boolean {
  return isElectron() && navigator.platform.toLowerCase().includes("mac");
}

/**
 * Check if running on macOS (web or Electron).
 */
export function isMacOS(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  return navigator.platform.toLowerCase().includes("mac");
}

/**
 * Get the API base URL for connecting to the Kiwi backend.
 * - Electron: uses the port injected by main process via window.__KIWI__.port
 * - Vite dev: uses Vite proxy, so empty string (relative URLs like /api/...)
 * - Production web: same-origin, so empty string
 */
export function getApiBaseUrl(): string {
  // In Electron, use the injected port
  if (window.__KIWI__?.port) {
    return `http://127.0.0.1:${window.__KIWI__.port}`;
  }
  // Web mode: relative URLs work with Vite proxy or same-origin
  return "";
}

/**
 * Generate a unique message ID
 * Uses crypto.randomUUID for true uniqueness to avoid key collisions
 * when switching sessions or reconnecting WebSocket
 */
export const createMessageId = (prefix: "user" | "assistant"): string => {
  // Fallback for older browsers
  return `${prefix}-${uuidV4()}`;
};

/**
 * Format relative time for session display
 */
export const formatRelativeTime = (date: Date): string => {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);

  if (minutes < 1) {
    return "Just now";
  } else if (minutes < 60) {
    return `${minutes}m ago`;
  } else {
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return `${hours}h ago`;
    } else {
      const days = Math.floor(hours / 24);
      return `${days}d ago`;
    }
  }
};

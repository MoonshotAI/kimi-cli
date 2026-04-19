import { useSyncExternalStore } from "react";
import { getAuthHeader } from "@/lib/auth";

export type BackendApp =
  | "finder"
  | "cursor"
  | "vscode"
  | "iterm"
  | "terminal"
  | "antigravity";

export type OpenTargetDef = {
  id: string;
  label: string;
  backendApp: BackendApp;
  macOnly?: boolean;
};

/**
 * Authoritative list of all supported open targets.
 * Components filter this list based on their needs.
 */
export const ALL_OPEN_TARGETS: OpenTargetDef[] = [
  { id: "finder", label: "Finder", backendApp: "finder", macOnly: true },
  { id: "cursor", label: "Cursor", backendApp: "cursor" },
  { id: "vscode", label: "VS Code", backendApp: "vscode" },
  { id: "antigravity", label: "Antigravity", backendApp: "antigravity" },
  { id: "iterm", label: "iTerm", backendApp: "iterm", macOnly: true },
  { id: "terminal", label: "Terminal", backendApp: "terminal", macOnly: true },
];

const LAST_OPEN_TARGET_KEY = "kimi-open-in-last-target";

/** In-memory subscribers for same-tab reactivity. */
const listeners = new Set<() => void>();

function getSnapshot(): string | null {
  try {
    return localStorage.getItem(LAST_OPEN_TARGET_KEY);
  } catch {
    return null;
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getLastOpenTargetId(): string | null {
  return getSnapshot();
}

export function setLastOpenTargetId(id: string): void {
  try {
    localStorage.setItem(LAST_OPEN_TARGET_KEY, id);
  } catch {
    /* ignore */
  }
  // Notify all subscribers in the same tab.
  for (const cb of listeners) cb();
}

/**
 * Reactive hook — returns the current last-used target ID and
 * re-renders whenever any component calls setLastOpenTargetId().
 */
export function useLastOpenTargetId(): string | null {
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

export async function openViaBackend(
  app: BackendApp,
  path: string,
): Promise<void> {
  const response = await fetch("/api/open-in", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeader() },
    body: JSON.stringify({ app, path }),
  });

  if (response.ok) {
    return;
  }

  let detail = "Failed to open application.";
  try {
    const data = await response.json();
    if (data?.detail) {
      detail = String(data.detail);
    }
  } catch {
    /* ignore */
  }
  throw new Error(detail);
}

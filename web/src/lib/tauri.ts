// Tauri v2's recommended detection path: the runtime injects
// `__TAURI_INTERNALS__` on `window` before any page script runs.
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

let backendUrl: string | null = null;
let authToken: string | null = null;
let initPromise: Promise<void> | null = null;

export function initTauriRuntime(): Promise<void> {
  if (initPromise) {
    return initPromise;
  }
  if (!isTauri()) {
    initPromise = Promise.resolve();
    return initPromise;
  }
  initPromise = (async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const [url, token] = await Promise.all([
      invoke<string>("backend_url"),
      invoke<string>("auth_token"),
    ]);
    backendUrl = url;
    authToken = token;
  })();
  return initPromise;
}

export function getTauriBackendUrl(): string | null {
  return backendUrl;
}

export function getTauriAuthToken(): string | null {
  return authToken;
}

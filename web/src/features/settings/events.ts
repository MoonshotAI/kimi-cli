export const GLOBAL_CONFIG_CHANGED_EVENT = "kiwi:global-config-changed" as const;

export function dispatchGlobalConfigChanged(): void {
  window.dispatchEvent(new Event(GLOBAL_CONFIG_CHANGED_EVENT));
}


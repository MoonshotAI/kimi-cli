/**
 * Copy text to clipboard with broad browser compatibility.
 *
 * Safari is strict about user-activation: `navigator.clipboard.writeText()`
 * may silently fail when the page is served over port-forwarded HTTP, even on
 * localhost, because the async call can "expire" the transient user gesture.
 *
 * Strategy: try the **synchronous** `execCommand("copy")` first — it always
 * runs inside the caller's click handler and therefore preserves the user
 * gesture.  If it fails (e.g. the browser has removed the legacy API), fall
 * back to the modern async Clipboard API.
 */
export function copyToClipboard(text: string): Promise<void> {
  // 1. Synchronous path — works in Safari, Chrome, Firefox, even non-secure contexts.
  try {
    copyViaExecCommand(text);
    return Promise.resolve();
  } catch {
    // execCommand unavailable or blocked — continue to async API.
  }

  // 2. Async Clipboard API — requires secure context + user activation.
  if (navigator?.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }

  return Promise.reject(new Error("Clipboard not available"));
}

function copyViaExecCommand(text: string): void {
  const textarea = document.createElement("textarea");
  textarea.value = text;

  // Prevent scrolling / layout shift.
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    const ok = document.execCommand("copy");
    if (!ok) {
      throw new Error("execCommand copy returned false");
    }
  } finally {
    document.body.removeChild(textarea);
  }
}

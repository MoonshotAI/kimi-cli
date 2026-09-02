import { test as base, expect } from "@playwright/test";

type RequestLog = { url: string; timestamp: number };

export const test = base.extend<{
  createSession: () => Promise<string>;
  apiTracker: {
    logs: RequestLog[];
    getCallsTo: (pattern: string) => RequestLog[];
  };
  consoleErrors: string[];
}>({
  createSession: async ({ page }, use) => {
    await use(async () => {
      // Target the button specifically (not the dialog which also matches aria-label)
      await page.locator('button[aria-label="New Session"]').click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor({ state: "visible", timeout: 5000 });
      // Press Enter to select the default directory (startup dir)
      await dialog.locator("input").press("Enter");
      await page.waitForURL(/session=/, { timeout: 10000 });
      return new URL(page.url()).searchParams.get("session") ?? "";
    });
  },

  apiTracker: async ({ page }, use) => {
    const logs: RequestLog[] = [];
    await page.route("/api/**", async (route) => {
      logs.push({ url: route.request().url(), timestamp: Date.now() });
      await route.continue();
    });
    await use({
      logs,
      getCallsTo: (pattern: string) =>
        logs.filter((l) => l.url.includes(pattern)),
    });
  },

  consoleErrors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (err) => errors.push(err.message));
    await use(errors);
  },
});

export { expect };

/** Send a message in the chat input and wait for the response to appear. */
export async function sendMessage(
  page: import("@playwright/test").Page,
  text: string,
) {
  const textarea = page.locator("textarea");
  await textarea.waitFor({ state: "visible", timeout: 5000 });
  await textarea.fill(text);
  // Use keyboard Enter to submit (default behavior)
  await textarea.press("Enter");
}

/** Wait for an assistant response containing the given text. */
export async function waitForResponse(
  page: import("@playwright/test").Page,
  textFragment: string,
  timeout = 15000,
) {
  await page.getByText(textFragment).first().waitFor({ timeout });
}

import { test, expect, sendMessage, waitForResponse } from "./helpers/fixtures";

test.describe("Navigation & URL Sync", () => {
  test("session ID syncs with URL ?session= param", async ({
    page,
    createSession,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const sessionId = await createSession();

    // URL should contain session param
    const url = new URL(page.url());
    expect(url.searchParams.get("session")).toBe(sessionId);
  });

  test("navigating to URL with session param loads that session", async ({
    page,
    createSession,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Create session and send a message
    const sessionId = await createSession();
    await sendMessage(page, "navigation test msg");
    await waitForResponse(page, "Echo:");

    // Navigate away (to home without session)
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Navigate back to the session via URL
    await page.goto(`/?session=${sessionId}`);
    await page.waitForLoadState("networkidle");

    // The previous message should be visible in the chat area
    const chatLog = page.getByRole("log");
    await expect(chatLog.getByText("navigation test msg")).toBeVisible({
      timeout: 10000,
    });
  });

  test("creating a new session updates URL", async ({
    page,
    createSession,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Initially no session param
    const initialUrl = new URL(page.url());
    expect(initialUrl.searchParams.has("session")).toBeFalsy();

    // Create a session
    const sessionId = await createSession();

    // URL should now have session param
    const afterUrl = new URL(page.url());
    expect(afterUrl.searchParams.get("session")).toBe(sessionId);
  });
});

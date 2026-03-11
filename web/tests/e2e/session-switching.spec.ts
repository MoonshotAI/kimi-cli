import { test, expect, sendMessage, waitForResponse } from "./helpers/fixtures";

test.describe("Session Switching", () => {
  test("switching sessions shows correct conversation", async ({
    page,
    createSession,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Create first session and send a message
    const session1 = await createSession();
    await sendMessage(page, "session one hello");
    await waitForResponse(page, "Echo:");

    // Create second session and send a different message
    const session2 = await createSession();
    // Wait for the new session to be ready (textarea placeholder changes)
    await page.locator("textarea").waitFor({ state: "visible", timeout: 10000 });
    await page.waitForTimeout(1000); // Wait for WS connection
    await sendMessage(page, "session two hello");
    await waitForResponse(page, "Echo:");

    // Verify second session content is visible in the chat area
    const chatLog = page.getByRole("log");
    await expect(chatLog.getByText("session two hello")).toBeVisible();

    // Switch back to first session via URL
    await page.goto(`/?session=${session1}`);
    await page.waitForLoadState("networkidle");
    // Wait for session to load
    await page.waitForTimeout(2000);

    // Verify first session content is visible
    await expect(chatLog.getByText("session one hello")).toBeVisible({ timeout: 10000 });
  });

  test("stream events do not leak across sessions", async ({
    page,
    createSession,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Create session and send message
    await createSession();
    await sendMessage(page, "leak test message");
    await waitForResponse(page, "Echo:");

    // Create a new session
    await createSession();

    // The new session should show empty state, not messages from session1
    await page.waitForTimeout(1000);
    await expect(page.getByText("Start a conversation")).toBeVisible({ timeout: 5000 });
  });
});

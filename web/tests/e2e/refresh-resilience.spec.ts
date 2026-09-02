import { test, expect, sendMessage, waitForResponse } from "./helpers/fixtures";

test.describe("Refresh Resilience", () => {
  test("page refresh restores session and conversation", async ({
    page,
    createSession,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const sessionId = await createSession();
    await sendMessage(page, "before refresh");
    await waitForResponse(page, "Echo:");

    // Refresh the page
    await page.reload();
    await page.waitForLoadState("networkidle");

    // URL should still contain the session
    expect(page.url()).toContain(`session=${sessionId}`);

    // Previous messages should still be visible (loaded from history)
    await expect(page.getByText("before refresh")).toBeVisible({ timeout: 10000 });
  });

  test("refresh storm does not cause excessive API calls", async ({
    page,
    createSession,
    apiTracker,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const sessionId = await createSession();
    await sendMessage(page, "storm test");
    await waitForResponse(page, "Echo:");

    // Clear tracker logs before the storm
    apiTracker.logs.length = 0;

    // Rapid refreshes
    for (let i = 0; i < 3; i++) {
      await page.reload();
    }
    await page.waitForLoadState("networkidle");

    // Wait for any debounced requests to settle
    await page.waitForTimeout(2000);

    // Check that session-related API calls are reasonable
    // (not exponentially growing with each refresh)
    const sessionCalls = apiTracker.getCallsTo("/api/");
    // With 3 refreshes, we shouldn't see more than ~30 total API calls
    // (each page load makes a few calls for sessions, config, etc.)
    expect(sessionCalls.length).toBeLessThan(50);
  });
});

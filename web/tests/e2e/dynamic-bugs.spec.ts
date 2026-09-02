import { test, expect, sendMessage, waitForResponse } from "./helpers/fixtures";

test.describe("Dynamic Bugs & Edge Cases", () => {
  test("no console errors during normal usage", async ({
    page,
    createSession,
    consoleErrors,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await createSession();
    await sendMessage(page, "error check message");
    await waitForResponse(page, "Echo:");

    // Filter out known benign errors (e.g., React DevTools, favicon)
    const realErrors = consoleErrors.filter(
      (e) =>
        !e.includes("favicon") &&
        !e.includes("DevTools") &&
        !e.includes("react-scan") &&
        !e.includes("404"),
    );

    expect(realErrors).toEqual([]);
  });

  test("slow network does not break UI", async ({
    page,
    createSession,
    context,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await createSession();

    // Simulate slow network using CDP
    const cdpSession = await context.newCDPSession(page);
    await cdpSession.send("Network.emulateNetworkConditions", {
      offline: false,
      downloadThroughput: 50 * 1024, // 50 KB/s
      uploadThroughput: 50 * 1024,
      latency: 500, // 500ms latency
    });

    await sendMessage(page, "slow network test");

    // Even with slow network, the response should eventually appear
    await waitForResponse(page, "Echo:", 30000);

    // Restore normal network
    await cdpSession.send("Network.emulateNetworkConditions", {
      offline: false,
      downloadThroughput: -1,
      uploadThroughput: -1,
      latency: 0,
    });
  });

  test("rapid message sending does not corrupt state", async ({
    page,
    createSession,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await createSession();

    // Send first message and wait for response before sending next
    await sendMessage(page, "rapid msg 1");
    await waitForResponse(page, "Echo:");

    await sendMessage(page, "rapid msg 2");
    await waitForResponse(page, "Echo:");

    // Both messages should be visible in the chat log area
    const chatLog = page.getByRole("log");
    await expect(chatLog.getByText("rapid msg 1")).toBeVisible();
    await expect(chatLog.getByText("rapid msg 2")).toBeVisible();
  });
});

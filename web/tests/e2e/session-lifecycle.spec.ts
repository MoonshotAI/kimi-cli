import { test, expect, sendMessage, waitForResponse } from "./helpers/fixtures";

test.describe("Session Lifecycle", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
  });

  test("create session → send message → receive streamed response", async ({
    page,
    createSession,
  }) => {
    const sessionId = await createSession();
    expect(sessionId).toBeTruthy();

    // URL should contain session param
    expect(page.url()).toContain(`session=${sessionId}`);

    // Send a message and wait for the echo response
    await sendMessage(page, "Hello world");
    await waitForResponse(page, "Echo:");

    // Verify user message is visible
    await expect(page.getByText("Hello world")).toBeVisible();
  });

  test("archive session via context menu", async ({
    page,
    createSession,
  }) => {
    await createSession();
    await sendMessage(page, "message before archive");
    await waitForResponse(page, "Echo:");

    // The session title in sidebar becomes the first echo response.
    // Right-click the first session button with "Echo:" text in the sidebar.
    // Virtuoso renders items as <div> with <button> inside, not <li>.
    const sessionButton = page
      .locator("button")
      .filter({ hasText: /^Echo: test response/ })
      .first();
    await sessionButton.waitFor({ state: "visible", timeout: 5000 });
    await sessionButton.click({ button: "right" });

    // Click Archive in context menu
    const archiveButton = page.getByRole("menu").getByText("Archive");
    await archiveButton.waitFor({ state: "visible", timeout: 3000 });
    await archiveButton.click();

    // Wait for the archive action to complete
    await page.waitForTimeout(1000);
  });

  test("delete session via context menu", async ({
    page,
    createSession,
  }) => {
    const sessionId = await createSession();
    await sendMessage(page, "message before delete");
    await waitForResponse(page, "Echo:");

    // Right-click the session in sidebar
    const sessionButton = page
      .locator("button")
      .filter({ hasText: /^Echo: test response/ })
      .first();
    await sessionButton.waitFor({ state: "visible", timeout: 5000 });
    await sessionButton.click({ button: "right" });

    // Click Delete in context menu
    const deleteButton = page.getByRole("menu").getByText("Delete session");
    await deleteButton.waitFor({ state: "visible", timeout: 3000 });
    await deleteButton.click();

    // Confirm deletion in the alert dialog
    // The dialog has a red "Delete" button
    const confirmButton = page.getByRole("button", { name: "Delete", exact: true });
    await confirmButton.waitFor({ state: "visible", timeout: 3000 });
    await confirmButton.click();

    // Wait for deletion to complete
    await page.waitForTimeout(2000);
  });
});

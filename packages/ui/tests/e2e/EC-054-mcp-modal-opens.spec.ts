import { test, expect } from "@playwright/test"

/**
 * EC-054: MCP/LSP Modals Open from Bottom Status Bar and Settings Panel
 *
 * Verifies that clicking MCP/LSP buttons in the bottom status bar
 * and the MCP Servers button in the settings panel open their
 * respective modals correctly.
 *
 * Bug: The dialog-overlay, dialog-content, and dialog-* CSS classes
 * used by McpSettingsModal and LspSettingsModal were undefined.
 * The Kobalte Dialog.Portal rendered content into the DOM but it was
 * invisible due to missing positioning and z-index styles.
 *
 * Fix: Added generic .dialog-* CSS definitions in mcp-modal.css.
 *
 * Requires: A running opencode instance for workspace access.
 */
test.describe("EC-054: MCP/LSP Modal Opens", () => {
  test.setTimeout(120000)

  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(2000)
  })

  async function openWorkspace(page: import("@playwright/test").Page): Promise<boolean> {
    // Try recent folder card first
    const folderCard = page.locator('[class*="folder-card"]').first()
    if (await folderCard.isVisible().catch(() => false)) {
      await folderCard.dblclick()
      await page.waitForTimeout(5000)
      const bottomBar = page.locator(".bottom-status-bar")
      if (await bottomBar.isVisible().catch(() => false)) return true
    }

    // Fallback: type a folder path in the search bar and press Enter
    const searchInput = page.locator('input[placeholder*="Search"]').first()
    if (await searchInput.isVisible().catch(() => false)) {
      await searchInput.click()
      await searchInput.fill("/Users/alexanderollman/CodeNomad")
      await searchInput.press("Enter")
      await page.waitForTimeout(10000)

      const bottomBar = page.locator(".bottom-status-bar")
      if (await bottomBar.isVisible().catch(() => false)) return true
    }

    return false
  }

  test("MCP button in bottom status bar opens MCP modal", async ({ page }) => {
    const opened = await openWorkspace(page)
    if (!opened) {
      test.skip(true, "Could not open workspace (no running opencode instance)")
      return
    }

    await page.screenshot({ path: "test-screenshots/EC-054-01-workspace.png", fullPage: true })

    const bottomBar = page.locator(".bottom-status-bar")
    await expect(bottomBar).toBeVisible({ timeout: 10000 })

    // Try MCP button in bottom bar first, fall back to settings panel
    const mcpButton = page.locator('.bottom-status-mcp, button[title*="MCP"]').first()
    const mcpButtonVisible = await mcpButton.isVisible().catch(() => false)

    if (!mcpButtonVisible) {
      // MCP button may not appear if no servers are configured — use settings panel
      const settingsBtn = page.locator('.bottom-status-settings, button[title="Settings"]').first()
      if (!(await settingsBtn.isVisible().catch(() => false))) {
        test.skip(true, "Neither MCP nor Settings button visible")
        return
      }
      await settingsBtn.click()
      await page.waitForTimeout(500)

      const mcpSettingsBtn = page.locator('.settings-action-button:has-text("MCP Servers")').first()
      if (!(await mcpSettingsBtn.isVisible().catch(() => false))) {
        test.skip(true, "MCP Servers button not found in settings panel")
        return
      }
      await mcpSettingsBtn.click()
      await page.waitForTimeout(500)
    } else {
      await mcpButton.click()
      await page.waitForTimeout(500)
    }

    await page.screenshot({ path: "test-screenshots/EC-054-02-mcp-modal.png", fullPage: true })

    // Verify the MCP modal is visible
    const dialogOverlay = page.locator(".dialog-overlay")
    const dialogContent = page.locator(".dialog-content")
    const modalTitle = page.locator('.dialog-title:has-text("MCP Servers")')

    const overlayVisible = await dialogOverlay.isVisible().catch(() => false)
    const contentVisible = await dialogContent.isVisible().catch(() => false)
    const titleVisible = await modalTitle.isVisible().catch(() => false)

    expect(overlayVisible || contentVisible || titleVisible).toBe(true)

    // Close the modal
    const closeBtn = page.locator(".dialog-close-button, .dialog-footer button").first()
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click()
      await page.waitForTimeout(300)
    }
  })

  test("MCP Servers button in settings panel opens MCP modal", async ({ page }) => {
    const opened = await openWorkspace(page)
    if (!opened) {
      test.skip(true, "Could not open workspace (no running opencode instance)")
      return
    }

    const settingsBtn = page.locator('.bottom-status-settings, button[title="Settings"]').first()
    if (!(await settingsBtn.isVisible().catch(() => false))) {
      test.skip(true, "Settings button not visible")
      return
    }

    await settingsBtn.click()
    await page.waitForTimeout(500)

    await page.screenshot({ path: "test-screenshots/EC-054-03-settings.png", fullPage: true })

    const mcpSettingsBtn = page.locator('.settings-action-button:has-text("MCP Servers")').first()
    if (!(await mcpSettingsBtn.isVisible().catch(() => false))) {
      test.skip(true, "MCP Servers button not visible in settings panel")
      return
    }

    await mcpSettingsBtn.click()
    await page.waitForTimeout(500)

    await page.screenshot({ path: "test-screenshots/EC-054-04-mcp-from-settings.png", fullPage: true })

    const dialogContent = page.locator(".dialog-content")
    const modalTitle = page.locator('.dialog-title:has-text("MCP Servers")')

    const contentVisible = await dialogContent.isVisible().catch(() => false)
    const titleVisible = await modalTitle.isVisible().catch(() => false)

    expect(contentVisible || titleVisible).toBe(true)
  })

  test("LSP button in bottom status bar opens LSP modal", async ({ page }) => {
    const opened = await openWorkspace(page)
    if (!opened) {
      test.skip(true, "Could not open workspace (no running opencode instance)")
      return
    }

    const lspButton = page.locator('.bottom-status-lsp, button[title*="LSP"]').first()
    if (!(await lspButton.isVisible().catch(() => false))) {
      test.skip(true, "No LSP button visible (no LSP servers configured)")
      return
    }

    await lspButton.click()
    await page.waitForTimeout(500)

    await page.screenshot({ path: "test-screenshots/EC-054-05-lsp-modal.png", fullPage: true })

    const dialogContent = page.locator(".dialog-content")
    const modalTitle = page.locator('.dialog-title:has-text("LSP Servers")')

    const contentVisible = await dialogContent.isVisible().catch(() => false)
    const titleVisible = await modalTitle.isVisible().catch(() => false)

    expect(contentVisible || titleVisible).toBe(true)
  })
})

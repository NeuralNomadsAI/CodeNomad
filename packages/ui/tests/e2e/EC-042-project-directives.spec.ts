import { test, expect } from "@playwright/test"

test.describe("EC-042: Project Directives Markdown Analysis", () => {
  test("should analyze project directives after entering a session", async ({ page }) => {
    await page.goto("http://localhost:3000")
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(2000)

    await page.screenshot({ path: "test-screenshots/EC-042-01-initial.png", fullPage: true })

    // Step 1: Click on a Recent Project to open it
    const recentProject = page.locator(".folder-card, .recent-project-card, [data-testid='recent-project']").first()
    if (await recentProject.count() > 0) {
      console.log("Clicking on recent project...")
      await recentProject.click()
      await page.waitForTimeout(2000)
      await page.screenshot({ path: "test-screenshots/EC-042-02-project-opened.png", fullPage: true })
    }

    // Step 2: Enter a session - click on a session in the session list to see messages
    const sessionItem = page.locator(".session-item, .session-list-item, [data-testid='session-item']").first()
    if (await sessionItem.count() > 0) {
      console.log("Clicking on session to enter it...")
      await sessionItem.click()
      await page.waitForTimeout(2000)
      await page.screenshot({ path: "test-screenshots/EC-042-03-session-entered.png", fullPage: true })
    } else {
      // Try clicking on any session tab
      const sessionTab = page.locator(".session-tab, [role='tab']").first()
      if (await sessionTab.count() > 0) {
        console.log("Clicking on session tab...")
        await sessionTab.click()
        await page.waitForTimeout(2000)
        await page.screenshot({ path: "test-screenshots/EC-042-03-session-tab-clicked.png", fullPage: true })
      }
    }

    // Verify we're in a session by checking for message stream or prompt input
    const messageStream = page.locator(".message-stream, .messages-container, [data-testid='messages']")
    const promptInput = page.locator(".prompt-input, textarea[placeholder*='message'], [data-testid='prompt-input']")

    const inSession = (await messageStream.count() > 0) || (await promptInput.count() > 0)
    console.log(`In session: ${inSession}`)
    await page.screenshot({ path: "test-screenshots/EC-042-04-session-state.png", fullPage: true })

    // Step 3: Now open settings
    const settingsButton = page.locator(".bottom-status-settings, [title='Settings'], button:has(svg.lucide-settings)")
    if (await settingsButton.count() > 0) {
      console.log("Clicking settings button...")
      await settingsButton.first().click()
      await page.waitForTimeout(500)
      await page.screenshot({ path: "test-screenshots/EC-042-05-settings-open.png", fullPage: true })
    }

    // Step 4: Click "All Settings" to open full settings pane
    const allSettingsButton = page.locator("text=All Settings")
    if (await allSettingsButton.isVisible()) {
      console.log("Clicking All Settings...")
      await allSettingsButton.click()
      await page.waitForTimeout(500)
      await page.screenshot({ path: "test-screenshots/EC-042-06-full-settings.png", fullPage: true })
    }

    // Step 5: Navigate to Project Directives in sidebar
    const projectDirectivesNav = page.locator("button:has-text('Project Directives'), .full-settings-nav-item:has-text('Project Directives')")
    if (await projectDirectivesNav.count() > 0) {
      console.log("Clicking Project Directives nav...")
      await projectDirectivesNav.first().click()

      // Wait for directives to load (loading spinner to disappear)
      try {
        await page.waitForSelector(".directives-loading", { state: "hidden", timeout: 10000 })
        console.log("Directives finished loading")
      } catch {
        console.log("Loading indicator still visible or not found")
      }

      await page.waitForTimeout(2000)
      await page.screenshot({ path: "test-screenshots/EC-042-07-project-directives.png", fullPage: true })
    }

    // Step 6: Analyze what we see
    // Check for project dropdown
    const projectDropdown = page.locator(".project-selector-select, select")
    const dropdownCount = await projectDropdown.count()
    console.log(`Found ${dropdownCount} project dropdown(s)`)

    // Check for directive sections
    const directiveSections = page.locator(".directive-section")
    const sectionCount = await directiveSections.count()
    console.log(`Found ${sectionCount} directive sections`)

    // Check for directive cards
    const directiveCards = page.locator(".directive-card")
    const cardCount = await directiveCards.count()
    console.log(`Found ${cardCount} directive cards`)

    // Check for Cards/Raw toggle
    const viewToggle = page.locator(".directives-view-toggle")
    const hasViewToggle = await viewToggle.count() > 0
    console.log(`Has Cards/Raw toggle: ${hasViewToggle}`)

    // Check for empty state
    const emptyState = page.locator(".directives-empty")
    const hasEmptyState = await emptyState.count() > 0
    console.log(`Has empty state: ${hasEmptyState}`)

    // Check for "No Project Open" message
    const noProjectMsg = page.locator("text=No Project Open")
    const hasNoProjectMsg = await noProjectMsg.count() > 0
    console.log(`Has 'No Project Open' message: ${hasNoProjectMsg}`)

    // If we have sections, analyze the markdown structure
    if (sectionCount > 0) {
      console.log("\n=== Directive Sections Found ===")
      for (let i = 0; i < sectionCount; i++) {
        const section = directiveSections.nth(i)
        const titleEl = section.locator(".directive-section-title")
        const title = await titleEl.textContent()
        const countEl = section.locator(".directive-section-count")
        const count = await countEl.textContent()
        console.log(`Section ${i + 1}: "${title}" (${count} directives)`)
      }
    }

    // If we have cards, show some content
    if (cardCount > 0) {
      console.log("\n=== Sample Directive Cards ===")
      for (let i = 0; i < Math.min(5, cardCount); i++) {
        const card = directiveCards.nth(i)
        const text = await card.locator(".directive-card-text, .directive-card-text-readonly").textContent()
        console.log(`Card ${i + 1}: "${text?.substring(0, 80)}..."`)
      }
    }

    // Try switching to Raw mode if toggle exists
    if (hasViewToggle) {
      const rawButton = page.locator(".directives-view-toggle-btn:has-text('Raw')")
      if (await rawButton.count() > 0) {
        console.log("\nSwitching to Raw view...")
        await rawButton.click()
        await page.waitForTimeout(500)
        await page.screenshot({ path: "test-screenshots/EC-042-08-raw-view.png", fullPage: true })

        // Check raw content
        const rawEditor = page.locator(".directives-raw-editor, .directives-raw-editor-readonly, textarea")
        if (await rawEditor.count() > 0) {
          const rawContent = await rawEditor.first().inputValue().catch(() =>
            rawEditor.first().textContent()
          )
          console.log(`\n=== Raw Markdown Content (first 500 chars) ===`)
          console.log(rawContent?.substring(0, 500))
        }
      }
    }

    // Cycle through projects if dropdown has multiple options
    if (dropdownCount > 0) {
      const options = await projectDropdown.first().locator("option").all()
      console.log(`\n=== Available Projects (${options.length}) ===`)
      for (const option of options) {
        const value = await option.getAttribute("value")
        const text = await option.textContent()
        console.log(`- ${text} (${value})`)
      }

      // Select each project and check directives
      if (options.length > 1) {
        for (let i = 0; i < Math.min(3, options.length); i++) {
          const value = await options[i].getAttribute("value")
          console.log(`\nSelecting project: ${value}`)
          await projectDropdown.first().selectOption(value!)
          await page.waitForTimeout(1000)

          const newSectionCount = await directiveSections.count()
          const newCardCount = await directiveCards.count()
          console.log(`  -> Sections: ${newSectionCount}, Cards: ${newCardCount}`)

          await page.screenshot({ path: `test-screenshots/EC-042-09-project-${i + 1}.png`, fullPage: true })
        }
      }
    }

    await page.screenshot({ path: "test-screenshots/EC-042-10-final.png", fullPage: true })
  })
})

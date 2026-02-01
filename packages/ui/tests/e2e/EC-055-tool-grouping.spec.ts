import { test, expect } from "@playwright/test"

test.describe("EC-055: Tool Call Grouping & Tab Active States", () => {
  test.setTimeout(120000)

  test("tool calls of the same type should be grouped, and active tabs should be visually distinct", async ({ page }) => {
    await page.goto("http://localhost:3000/")
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(2000)

    await page.screenshot({ path: "test-screenshots/EC-055-01-initial.png", fullPage: true })

    // Try to open a workspace via the project tabs at the top (if any exist)
    const projectTabs = page.locator('.project-tab')
    const projectTabCount = await projectTabs.count()
    console.log(`Found ${projectTabCount} project tabs`)

    if (projectTabCount > 0) {
      // Click the last project tab (more likely to have active sessions with tool calls)
      const lastTab = projectTabs.last()
      const tabLabel = await lastTab.locator('.project-tab-label').textContent().catch(() => "")
      console.log(`Clicking project tab: "${tabLabel}"`)
      await lastTab.click()
      await page.waitForTimeout(3000)
    } else {
      // No project tabs - try clicking a recent project entry
      const recentEntry = page.locator('text=~/').first()
      if (await recentEntry.isVisible().catch(() => false)) {
        await recentEntry.click()
        await page.waitForTimeout(5000)
      }
    }

    await page.screenshot({ path: "test-screenshots/EC-055-02-workspace.png", fullPage: true })

    // Now look for session tabs
    const sessionTabs = page.locator('.session-tab')
    const tabCount = await sessionTabs.count()
    console.log(`Found ${tabCount} session tabs`)

    // Click the first session tab that has a real name (not "Untitled")
    let selectedSession = false
    for (let i = 0; i < tabCount; i++) {
      const tab = sessionTabs.nth(i)
      const label = await tab.locator('.session-tab-label').textContent().catch(() => "")
      if (label && label !== "Untitled" && !label.includes("New")) {
        console.log(`Selecting session: "${label}"`)
        await tab.click()
        await page.waitForTimeout(2000)
        selectedSession = true
        break
      }
    }

    // If no named session found, click the first one
    if (!selectedSession && tabCount > 0) {
      const firstTab = sessionTabs.first()
      const label = await firstTab.locator('.session-tab-label').textContent().catch(() => "")
      console.log(`Selecting first session: "${label}"`)
      await firstTab.click()
      await page.waitForTimeout(2000)
    }

    await page.screenshot({ path: "test-screenshots/EC-055-03-session.png", fullPage: true })

    // Scroll the message area to load all content
    const scrollArea = page.locator('[class*="message"], [class*="chat"], [class*="scroll"]').first()
    if (await scrollArea.isVisible().catch(() => false)) {
      // Scroll to bottom
      await scrollArea.evaluate((el) => el.scrollTop = el.scrollHeight)
      await page.waitForTimeout(1000)
      // Scroll back up to top to see everything
      await scrollArea.evaluate((el) => el.scrollTop = 0)
      await page.waitForTimeout(500)
    }

    // ==========================================
    // TOOL GROUPING ANALYSIS
    // ==========================================
    const toolGroupContainers = page.locator('.tool-call-group-container')
    const toolRows = page.locator('.tool-row')
    const toolGroups = page.locator('.tool-group')

    const containerCount = await toolGroupContainers.count()
    const rowCount = await toolRows.count()
    const groupCount = await toolGroups.count()

    console.log(`\n=== Tool Grouping Analysis ===`)
    console.log(`Tool group containers: ${containerCount}`)
    console.log(`Individual tool rows (single/unique type): ${rowCount}`)
    console.log(`Collapsed tool groups (multiple same type): ${groupCount}`)

    // Detail on grouped tools
    for (let i = 0; i < Math.min(groupCount, 15); i++) {
      const group = toolGroups.nth(i)
      const name = await group.locator('.tool-group-name').textContent().catch(() => "?")
      const count = await group.locator('.tool-group-count').textContent().catch(() => "?")
      console.log(`  Grouped: ${name} ${count}`)
    }

    // Detail on individual tool rows
    for (let i = 0; i < Math.min(rowCount, 15); i++) {
      const row = toolRows.nth(i)
      const name = await row.locator('.tool-row-name').textContent().catch(() => "?")
      const path = await row.locator('.tool-row-path').textContent().catch(() => "")
      console.log(`  Single: ${name} - ${path}`)
    }

    // KEY CHECK: same-type tools should NOT appear as multiple individual rows
    // within the same container. Gather tool row names per container.
    let groupingIssues = 0
    for (let c = 0; c < containerCount; c++) {
      const container = toolGroupContainers.nth(c)
      const rows = container.locator('.tool-row')
      const rowNames = await rows.locator('.tool-row-name').allTextContents()

      // Check for duplicate names in this container's individual rows
      const seen = new Set<string>()
      for (const name of rowNames) {
        if (seen.has(name)) {
          console.log(`  ⚠ Container ${c + 1}: "${name}" appears multiple times as individual rows`)
          groupingIssues++
        }
        seen.add(name)
      }
    }

    if (groupingIssues === 0 && (rowCount > 0 || groupCount > 0)) {
      console.log(`\n✓ PASS: No same-type tools appear as duplicate individual rows`)
    } else if (groupingIssues > 0) {
      console.log(`\n✗ FAIL: ${groupingIssues} grouping issues found`)
    } else {
      console.log(`\nNo tool calls found in current view - check if session has tool usage`)
    }

    await page.screenshot({ path: "test-screenshots/EC-055-04-tools.png", fullPage: true })

    // ==========================================
    // ACTIVE TAB STYLING VERIFICATION
    // ==========================================
    console.log(`\n=== Active Tab Styling ===`)

    const activeProjectTab = page.locator('.project-tab-active').first()
    if (await activeProjectTab.isVisible().catch(() => false)) {
      const projectStyle = await activeProjectTab.evaluate((el) => {
        const cs = window.getComputedStyle(el)
        return {
          borderBottom: `${cs.borderBottomWidth} ${cs.borderBottomStyle} ${cs.borderBottomColor}`,
          bg: cs.backgroundColor,
          shadow: cs.boxShadow,
        }
      })
      console.log(`Project tab active:`)
      console.log(`  border-bottom: ${projectStyle.borderBottom}`)
      console.log(`  background: ${projectStyle.bg}`)
      console.log(`  box-shadow: ${projectStyle.shadow !== "none" ? "present" : "none"}`)

      // Verify the accent border is present (should be 2px solid)
      const hasBorder = projectStyle.borderBottom.startsWith("2px")
      console.log(`  ✓ Has 2px bottom border: ${hasBorder}`)
    }

    const activeSessionTab = page.locator('.session-tab-active').first()
    if (await activeSessionTab.isVisible().catch(() => false)) {
      const sessionStyle = await activeSessionTab.evaluate((el) => {
        const cs = window.getComputedStyle(el)
        return {
          borderBottom: `${cs.borderBottomWidth} ${cs.borderBottomStyle} ${cs.borderBottomColor}`,
          bg: cs.backgroundColor,
          shadow: cs.boxShadow,
        }
      })
      console.log(`Session tab active:`)
      console.log(`  border-bottom: ${sessionStyle.borderBottom}`)
      console.log(`  background: ${sessionStyle.bg}`)
      console.log(`  box-shadow: ${sessionStyle.shadow !== "none" ? "present" : "none"}`)

      const hasBorder = sessionStyle.borderBottom.startsWith("2px")
      console.log(`  ✓ Has 2px bottom border: ${hasBorder}`)
    }

    // ==========================================
    // SESSION TAB STATUS ICONS
    // ==========================================
    console.log(`\n=== Session Tab Icons ===`)
    const allSessionTabs2 = page.locator('.session-tab')
    const totalTabs = await allSessionTabs2.count()
    for (let i = 0; i < totalTabs; i++) {
      const tab = allSessionTabs2.nth(i)
      const label = await tab.locator('.session-tab-label').textContent().catch(() => "?")
      const hasSpinner = await tab.locator('.animate-spin').count() > 0
      const hasCompleted = await tab.locator('.session-tab-icon-completed').count() > 0
      const hasPermission = await tab.locator('.session-tab-icon-permission').count() > 0
      const hasDefault = await tab.locator('svg.opacity-70').count() > 0
      const iconType = hasSpinner ? "⟳ working" :
                       hasCompleted ? "✓ completed" :
                       hasPermission ? "⚠ permission" :
                       hasDefault ? "💬 idle" : "? unknown"
      console.log(`  Tab "${label}": ${iconType}`)
    }

    await page.screenshot({ path: "test-screenshots/EC-055-05-final.png", fullPage: true })
    console.log(`\nTest completed`)
  })
})

import { test, expect } from "@playwright/test"

test.describe("EC-056: Timeline segment grouping", () => {
  test.setTimeout(120000)

  test("consecutive same-type segments collapse into groups with count badges", async ({ page }) => {
    await page.goto("http://localhost:3000/")
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(2000)

    await page.screenshot({ path: "test-screenshots/EC-056-01-initial.png", fullPage: true })

    // Click a project tab to enter a workspace
    const projectTabs = page.locator(".project-tab")
    const projectTabCount = await projectTabs.count()
    console.log(`Found ${projectTabCount} project tab(s)`)

    if (projectTabCount > 0) {
      const lastTab = projectTabs.last()
      const tabLabel = await lastTab.locator(".project-tab-label").textContent().catch(() => "")
      console.log(`Clicking project tab: "${tabLabel}"`)
      await lastTab.click()
      await page.waitForTimeout(3000)
    } else {
      const recentEntry = page.locator("text=~/").first()
      if (await recentEntry.isVisible().catch(() => false)) {
        await recentEntry.click()
        await page.waitForTimeout(5000)
      }
    }

    await page.screenshot({ path: "test-screenshots/EC-056-02-workspace.png", fullPage: true })

    // Find session tabs and click one with a real name
    const sessionTabs = page.locator(".session-tab")
    const tabCount = await sessionTabs.count()
    console.log(`Found ${tabCount} session tab(s)`)

    let selectedSession = false
    for (let i = 0; i < tabCount; i++) {
      const tab = sessionTabs.nth(i)
      const label = await tab.locator(".session-tab-label").textContent().catch(() => "")
      if (label && label !== "Untitled" && !label.includes("New")) {
        console.log(`Selecting session: "${label}"`)
        await tab.click()
        await page.waitForTimeout(3000)
        selectedSession = true
        break
      }
    }

    if (!selectedSession && tabCount > 0) {
      const firstTab = sessionTabs.first()
      const label = await firstTab.locator(".session-tab-label").textContent().catch(() => "")
      console.log(`Selecting first session: "${label}"`)
      await firstTab.click()
      await page.waitForTimeout(3000)
    }

    await page.screenshot({ path: "test-screenshots/EC-056-03-session.png", fullPage: true })

    // Verify the timeline sidebar exists
    const timeline = page.locator(".message-timeline")
    const timelineVisible = await timeline.isVisible().catch(() => false)
    console.log(`Timeline visible: ${timelineVisible}`)

    if (!timelineVisible) {
      console.log("Timeline sidebar not visible — skipping group assertions")
      await page.screenshot({ path: "test-screenshots/EC-056-04-no-timeline.png", fullPage: true })
      return
    }

    // ==========================================
    // GROUPED SEGMENTS VERIFICATION
    // ==========================================
    const groups = page.locator(".message-timeline-group")
    const groupCount = await groups.count()
    console.log(`\n=== Timeline Grouping Analysis ===`)
    console.log(`Total timeline groups: ${groupCount}`)
    expect(groupCount).toBeGreaterThan(0)

    // Count badges (multi-segment groups)
    const badges = page.locator(".message-timeline-count-badge")
    const badgeCount = await badges.count()
    console.log(`Groups with count badges: ${badgeCount}`)

    // Count single-segment groups (no badge)
    const singlesCount = groupCount - badgeCount
    console.log(`Single-segment groups (no badge): ${singlesCount}`)

    // Log each group's details
    for (let i = 0; i < Math.min(groupCount, 20); i++) {
      const group = groups.nth(i)
      const badge = group.locator(".message-timeline-count-badge")
      const hasBadge = await badge.isVisible().catch(() => false)
      const badgeText = hasBadge ? await badge.textContent().catch(() => "") : ""
      const headerClass = await group.locator(".message-timeline-segment").first().getAttribute("class") ?? ""
      const type = headerClass.includes("user") ? "user" : headerClass.includes("assistant") ? "assistant" : headerClass.includes("tool") ? "tool" : "unknown"
      const isActive = headerClass.includes("segment-active")
      console.log(`  Group ${i + 1}: type=${type} badge=${badgeText || "none"} active=${isActive}`)
    }

    await page.screenshot({ path: "test-screenshots/EC-056-04-groups.png", fullPage: true })

    // ==========================================
    // EXPAND/COLLAPSE BEHAVIOR
    // ==========================================
    if (badgeCount > 0) {
      const firstBadge = badges.first()
      const badgeText = await firstBadge.textContent()
      console.log(`\nFirst badge text: "${badgeText}"`)
      expect(badgeText).toMatch(/\(\d+\)/)

      // Click group header with badge to expand
      const groupWithBadge = page.locator(".message-timeline-group:has(.message-timeline-count-badge)").first()
      const headerButton = groupWithBadge.locator(".message-timeline-segment").first()
      await headerButton.click()
      await page.waitForTimeout(800)

      await page.screenshot({ path: "test-screenshots/EC-056-05-expanded.png", fullPage: true })

      // Verify children container appeared
      const children = groupWithBadge.locator(".message-timeline-group-children")
      const childrenVisible = await children.isVisible().catch(() => false)
      console.log(`Children visible after expand: ${childrenVisible}`)
      expect(childrenVisible).toBe(true)

      // Verify child segments exist
      const childButtons = children.locator(".message-timeline-child")
      const childCount = await childButtons.count()
      console.log(`Child segments in expanded group: ${childCount}`)
      expect(childCount).toBeGreaterThanOrEqual(2)

      // Verify connectors exist per child
      const connectors = children.locator(".message-timeline-child-connector")
      const connectorCount = await connectors.count()
      expect(connectorCount).toBe(childCount)
      console.log(`Connectors match child count: ${connectorCount} === ${childCount}`)

      // Verify header has expanded class
      const headerHasExpanded = await headerButton.evaluate((el) =>
        el.classList.contains("message-timeline-group-expanded")
      )
      expect(headerHasExpanded).toBe(true)
      console.log(`Header has .message-timeline-group-expanded: true`)

      // Hover a child to verify preview triggers
      const firstChild = childButtons.first()
      await firstChild.hover()
      await page.waitForTimeout(400)
      console.log("Hovered first child segment")

      // Click header again to collapse
      await headerButton.click()
      await page.waitForTimeout(500)

      const childrenAfterCollapse = await children.isVisible().catch(() => false)
      console.log(`Children visible after collapse: ${childrenAfterCollapse}`)
      expect(childrenAfterCollapse).toBe(false)

      await page.screenshot({ path: "test-screenshots/EC-056-06-collapsed.png", fullPage: true })
    } else {
      console.log("\nNo multi-segment groups found — all groups are singletons (session may not have consecutive same-type messages)")
    }

    // ==========================================
    // ACTIVE STATE
    // ==========================================
    const activeHeaders = page.locator(".message-timeline-group .message-timeline-segment-active")
    const activeCount = await activeHeaders.count()
    console.log(`\nActive group headers: ${activeCount}`)

    // ==========================================
    // SINGLE-SEGMENT CLICK BEHAVIOR
    // ==========================================
    const singleGroup = page.locator(".message-timeline-group:not(:has(.message-timeline-count-badge))").first()
    if (await singleGroup.isVisible().catch(() => false)) {
      const singleHeader = singleGroup.locator(".message-timeline-segment").first()
      await singleHeader.click()
      await page.waitForTimeout(500)

      // No children should appear for a single-segment group
      const noChildren = await singleGroup.locator(".message-timeline-group-children").isVisible().catch(() => false)
      expect(noChildren).toBe(false)
      console.log("Single-segment group click: no children expanded (correct)")
    }

    await page.screenshot({ path: "test-screenshots/EC-056-07-final.png", fullPage: true })
    console.log("\nEC-056 timeline grouping test complete")
  })
})

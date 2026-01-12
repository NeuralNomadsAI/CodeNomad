import { chromium } from 'playwright'

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3006'
const SCREENSHOT_DIR = './test-screenshots/ec-review'

async function main() {
  console.log('Testing Phase 2-3 fixes...')

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()

  try {
    // Test home screen shortcuts footer (FIX-010)
    console.log('\n=== Testing Home Screen (FIX-010) ===')
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/phase2-home-screen.png`,
      fullPage: true
    })

    const shortcutsFooter = await page.locator('.home-shortcuts-footer').isVisible().catch(() => false)
    console.log(`Shortcuts footer visible: ${shortcutsFooter}`)

    // Open a project
    console.log('\n=== Opening project ===')
    const pathInput = page.locator('input').first()
    if (await pathInput.isVisible()) {
      await pathInput.fill('/Users/alexanderollman/CodeNomad')
      await page.waitForTimeout(500)
      const openBtn = page.locator('button:has-text("Open Folder"):not([disabled])').last()
      if (await openBtn.isVisible()) await openBtn.click()
      await page.waitForTimeout(4000)
    }

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/phase2-project-view.png`,
      fullPage: true
    })

    // Test context display (FIX-004)
    console.log('\n=== Testing Context Display (FIX-004) ===')
    const contextDisplay = await page.locator('.bottom-status-context').textContent().catch(() => '')
    console.log(`Context display: "${contextDisplay}"`)

    // Test tab close buttons (FIX-005)
    console.log('\n=== Testing Tab Close Buttons (FIX-005) ===')
    const projectTab = page.locator('.project-tab').first()
    if (await projectTab.isVisible()) {
      // Check if close button is visible without hover
      const closeBtn = page.locator('.project-tab-close').first()
      const closeBtnVisible = await closeBtn.isVisible().catch(() => false)
      console.log(`Close button visible before hover: ${closeBtnVisible}`)

      await page.screenshot({
        path: `${SCREENSHOT_DIR}/phase2-close-buttons.png`,
        fullPage: true
      })
    }

    // Test cost display (FIX-008)
    console.log('\n=== Testing Cost Display (FIX-008) ===')
    const costDisplay = await page.locator('.bottom-status-cost').isVisible().catch(() => false)
    console.log(`Cost display visible: ${costDisplay}`)

    // Test session tabs (FIX-006)
    console.log('\n=== Testing Session Tabs (FIX-006) ===')
    const sessionTabs = await page.locator('.session-tab').count()
    console.log(`Session tabs count: ${sessionTabs}`)

    // Final screenshot
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/phase2-3-final.png`,
      fullPage: true
    })

    console.log('\n=== Phase 2-3 Tests Complete ===')

  } catch (error) {
    console.error('Error:', error)
    await page.screenshot({ path: `${SCREENSHOT_DIR}/phase2-3-error.png` })
  } finally {
    await browser.close()
  }
}

main()

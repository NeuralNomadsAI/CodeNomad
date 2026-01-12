import { chromium } from 'playwright'

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3006'
const SCREENSHOT_DIR = './test-screenshots/ec-review'

async function main() {
  console.log(`Starting comprehensive visual review against ${BASE_URL}`)

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }
  })
  const page = await context.newPage()

  // Capture errors
  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log(`[ERROR]`, msg.text())
    }
  })

  try {
    // 1. Home Screen (EC-003)
    console.log('\n=== EC-003: Home Screen ===')
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/01-home-screen.png`,
      fullPage: true
    })
    console.log('Screenshot: 01-home-screen.png')

    // Check for Recent Folders
    const recentFolders = await page.locator('text=Recent Folders').isVisible()
    console.log(`Recent Folders visible: ${recentFolders}`)

    // Check for Browse Folders button
    const browseFolders = await page.locator('button:has-text("Browse Folders")').isVisible()
    console.log(`Browse Folders button visible: ${browseFolders}`)

    // Check for Open by Path
    const openByPath = await page.locator('text=Open by Path').isVisible()
    console.log(`Open by Path visible: ${openByPath}`)

    // Hover on a recent folder item
    const folderItems = page.locator('.recent-folder-item, [class*="folder-item"]').first()
    if (await folderItems.isVisible().catch(() => false)) {
      await folderItems.hover()
      await page.waitForTimeout(300)
      await page.screenshot({
        path: `${SCREENSHOT_DIR}/02-home-folder-hover.png`,
        fullPage: true
      })
      console.log('Screenshot: 02-home-folder-hover.png')
    }

    // 2. Click on a recent folder to open a project (EC-001 and EC-002)
    console.log('\n=== Opening a project... ===')

    // Use the "Open by Path" input - most reliable approach
    const pathInput = page.locator('input')
    if (await pathInput.isVisible().catch(() => false)) {
      console.log('Using path input to open project...')
      await pathInput.click()
      await pathInput.fill('/Users/alexanderollman/CodeNomad')
      await page.waitForTimeout(500)

      await page.screenshot({
        path: `${SCREENSHOT_DIR}/02b-path-entered.png`,
        fullPage: true
      })

      // Find the "Open Folder" button that's NOT disabled
      const openFolderBtn = page.locator('button:has-text("Open Folder"):not([disabled])').last()
      console.log('Open Folder button visible:', await openFolderBtn.isVisible().catch(() => false))
      if (await openFolderBtn.isVisible().catch(() => false)) {
        await openFolderBtn.click({ timeout: 5000 })
        await page.waitForTimeout(5000) // Wait longer for instance to start
      }
    }

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/03-project-opened.png`,
      fullPage: true
    })
    console.log('Screenshot: 03-project-opened.png')

    // Check for project tabs (EC-001)
    console.log('\n=== EC-001: Project Tab Bar ===')
    const projectTabs = await page.locator('[class*="project-tab"], [class*="instance-tab"]').count()
    console.log(`Project tabs count: ${projectTabs}`)

    // Check for session tabs (EC-002)
    console.log('\n=== EC-002: Session Tab Bar ===')
    const sessionTabs = await page.locator('[class*="session-tab"]').count()
    console.log(`Session tabs count: ${sessionTabs}`)

    // Check for bottom status bar (EC-006)
    console.log('\n=== EC-006: Bottom Status Bar ===')
    const statusBar = await page.locator('[class*="status-bar"], [class*="bottom-bar"]').isVisible().catch(() => false)
    console.log(`Bottom status bar visible: ${statusBar}`)

    // Check for settings button (EC-004)
    console.log('\n=== EC-004: Settings/Status Indicator ===')
    const settingsBtn = await page.locator('[class*="settings"], button[title*="Settings"]').first().isVisible().catch(() => false)
    console.log(`Settings button visible: ${settingsBtn}`)

    // If settings button visible, click it to open settings panel
    if (settingsBtn) {
      // Find the settings button more specifically (the gear icon in the tab bar)
      const gearBtn = page.locator('.project-tab-bar-settings, button:has(.lucide-settings)').first()
      if (await gearBtn.isVisible().catch(() => false)) {
        await gearBtn.click()
        await page.waitForTimeout(500)

        await page.screenshot({
          path: `${SCREENSHOT_DIR}/04-settings-panel.png`,
          fullPage: true
        })
        console.log('Screenshot: 04-settings-panel.png')

        // Press Escape to close
        await page.keyboard.press('Escape')
        await page.waitForTimeout(300)
      }
    }

    // Check for model selector in status bar (EC-006b)
    const modelBtn = await page.locator('[class*="model"], button:has-text("Model")').first().isVisible().catch(() => false)
    console.log(`Model button visible: ${modelBtn}`)

    if (modelBtn) {
      await page.locator('[class*="model"], button:has-text("Model")').first().click()
      await page.waitForTimeout(500)

      await page.screenshot({
        path: `${SCREENSHOT_DIR}/05-model-selector.png`,
        fullPage: true
      })
      console.log('Screenshot: 05-model-selector.png')

      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
    }

    // Try keyboard shortcut for model selector (Cmd+Shift+M)
    console.log('\n=== Testing Cmd+Shift+M shortcut ===')
    await page.keyboard.press('Meta+Shift+m')
    await page.waitForTimeout(500)

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/06-model-selector-shortcut.png`,
      fullPage: true
    })
    console.log('Screenshot: 06-model-selector-shortcut.png')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    // Check for close tab modal (EC-005)
    console.log('\n=== EC-005: Close Tab Modal ===')
    const tabCloseBtn = await page.locator('[class*="tab-close"], [class*="close-button"]').first().isVisible().catch(() => false)
    console.log(`Tab close button visible: ${tabCloseBtn}`)

    if (tabCloseBtn) {
      // Hover first to make close button appear
      const tab = page.locator('[class*="project-tab"], [class*="instance-tab"]').first()
      if (await tab.isVisible().catch(() => false)) {
        await tab.hover()
        await page.waitForTimeout(300)

        const closeOnHover = await page.locator('[class*="tab-close"], [class*="close"]').first()
        if (await closeOnHover.isVisible().catch(() => false)) {
          await closeOnHover.click()
          await page.waitForTimeout(500)

          await page.screenshot({
            path: `${SCREENSHOT_DIR}/07-close-modal.png`,
            fullPage: true
          })
          console.log('Screenshot: 07-close-modal.png')

          // Cancel the modal
          const cancelBtn = page.locator('button:has-text("Cancel")')
          if (await cancelBtn.isVisible().catch(() => false)) {
            await cancelBtn.click()
            await page.waitForTimeout(300)
          } else {
            await page.keyboard.press('Escape')
            await page.waitForTimeout(300)
          }
        }
      }
    }

    // New tab button (EC-001)
    console.log('\n=== EC-001: New Tab Button ===')
    const newTabBtn = await page.locator('[class*="new-tab"], button:has-text("+")').first().isVisible().catch(() => false)
    console.log(`New tab button visible: ${newTabBtn}`)

    if (newTabBtn) {
      await page.locator('[class*="new-tab"], button:has-text("+")').first().click()
      await page.waitForTimeout(500)

      await page.screenshot({
        path: `${SCREENSHOT_DIR}/08-new-tab-clicked.png`,
        fullPage: true
      })
      console.log('Screenshot: 08-new-tab-clicked.png')
    }

    // Final state
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/09-final-state.png`,
      fullPage: true
    })
    console.log('\nScreenshot: 09-final-state.png')

    // Print page content for debugging
    console.log('\n=== DOM Analysis ===')
    const bodyClasses = await page.evaluate(() => {
      const elements = document.querySelectorAll('[class]')
      const classes = new Set<string>()
      elements.forEach(el => {
        el.className.split(' ').forEach(c => {
          if (c.includes('tab') || c.includes('bar') || c.includes('status') ||
              c.includes('modal') || c.includes('settings') || c.includes('model')) {
            classes.add(c)
          }
        })
      })
      return Array.from(classes).sort()
    })
    console.log('Relevant classes found:', bodyClasses.join(', '))

    console.log('\n=== Visual Review Complete ===')

  } catch (error) {
    console.error('Error during visual review:', error)
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/error-state.png`,
      fullPage: true
    })
  } finally {
    await browser.close()
  }
}

main()

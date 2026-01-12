import { chromium } from 'playwright'

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9900'
const SCREENSHOT_DIR = './test-screenshots/ec-review'

async function main() {
  console.log(`Starting visual review against ${BASE_URL}`)

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }
  })
  const page = await context.newPage()

  try {
    // 1. Home Screen / Initial Load
    console.log('\n=== EC-003: Home Screen ===')
    await page.goto(BASE_URL)
    await page.waitForTimeout(3000) // Wait for app to fully load

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/01-home-screen-initial.png`,
      fullPage: true
    })
    console.log('Screenshot: 01-home-screen-initial.png')

    // Check what's visible
    const homeScreen = await page.locator('.home-screen').isVisible().catch(() => false)
    const projectTabBar = await page.locator('.project-tab-bar').isVisible().catch(() => false)

    console.log(`Home screen visible: ${homeScreen}`)
    console.log(`Project tab bar visible: ${projectTabBar}`)

    if (homeScreen) {
      // Check EC-003 elements
      const searchBar = await page.locator('.home-search-input').isVisible().catch(() => false)
      const recentCard = await page.locator('.home-card').filter({ hasText: 'Recent' }).isVisible().catch(() => false)
      const browseCard = await page.locator('.home-card').filter({ hasText: 'Browse' }).isVisible().catch(() => false)
      const githubCard = await page.locator('.home-card').filter({ hasText: 'GitHub' }).isVisible().catch(() => false)
      const branding = await page.locator('.home-branding, h1, h2').first().isVisible().catch(() => false)
      const shortcuts = await page.locator('.home-shortcuts').isVisible().catch(() => false)

      console.log(`\nEC-003 Elements:`)
      console.log(`  Search bar: ${searchBar}`)
      console.log(`  Recent card: ${recentCard}`)
      console.log(`  Browse card: ${browseCard}`)
      console.log(`  GitHub card: ${githubCard}`)
      console.log(`  Branding: ${branding}`)
      console.log(`  Keyboard shortcuts: ${shortcuts}`)

      // Screenshot of hover states
      const cards = page.locator('.home-card')
      const cardCount = await cards.count()
      if (cardCount > 0) {
        await cards.first().hover()
        await page.waitForTimeout(300)
        await page.screenshot({
          path: `${SCREENSHOT_DIR}/02-home-card-hover.png`,
          fullPage: true
        })
        console.log('Screenshot: 02-home-card-hover.png')
      }
    }

    if (projectTabBar) {
      // We have instances - check all EC features
      console.log('\n=== EC-001: Project Tab Bar ===')

      const tabs = page.locator('.project-tab')
      const tabCount = await tabs.count()
      console.log(`Project tabs count: ${tabCount}`)

      const newTabButton = await page.locator('.project-new-tab, .new-tab-button').isVisible().catch(() => false)
      const settingsButton = await page.locator('.project-tab-bar-settings').isVisible().catch(() => false)

      console.log(`New tab button: ${newTabButton}`)
      console.log(`Settings button: ${settingsButton}`)

      await page.screenshot({
        path: `${SCREENSHOT_DIR}/03-project-tabs.png`,
        fullPage: true
      })
      console.log('Screenshot: 03-project-tabs.png')

      // Hover on tab to show close button
      if (tabCount > 0) {
        await tabs.first().hover()
        await page.waitForTimeout(300)
        await page.screenshot({
          path: `${SCREENSHOT_DIR}/04-project-tab-hover.png`,
          fullPage: true
        })
        console.log('Screenshot: 04-project-tab-hover.png')
      }

      // EC-002: Session Tabs
      console.log('\n=== EC-002: Session Tab Bar ===')
      const sessionTabs = page.locator('.session-tab-bar, .session-tabs')
      const sessionTabBarVisible = await sessionTabs.isVisible().catch(() => false)
      console.log(`Session tab bar visible: ${sessionTabBarVisible}`)

      if (sessionTabBarVisible) {
        const sessionTabItems = page.locator('.session-tab')
        const sessionCount = await sessionTabItems.count()
        console.log(`Session tabs count: ${sessionCount}`)

        await page.screenshot({
          path: `${SCREENSHOT_DIR}/05-session-tabs.png`,
          fullPage: true
        })
        console.log('Screenshot: 05-session-tabs.png')
      }

      // EC-004: Settings Panel
      console.log('\n=== EC-004: Settings Panel ===')
      if (settingsButton) {
        await page.locator('.project-tab-bar-settings').click()
        await page.waitForTimeout(500)

        const settingsPanel = await page.locator('.settings-panel').isVisible().catch(() => false)
        console.log(`Settings panel opened: ${settingsPanel}`)

        await page.screenshot({
          path: `${SCREENSHOT_DIR}/06-settings-panel.png`,
          fullPage: true
        })
        console.log('Screenshot: 06-settings-panel.png')

        // Close settings panel
        const closeBtn = page.locator('.settings-panel-close')
        if (await closeBtn.isVisible()) {
          await closeBtn.click()
          await page.waitForTimeout(300)
        }
      }

      // EC-005: Close Tab Modal
      console.log('\n=== EC-005: Close Tab Modal ===')
      if (tabCount > 0) {
        await tabs.first().hover()
        await page.waitForTimeout(200)
        const closeBtn = page.locator('.project-tab-close, .tab-close').first()
        if (await closeBtn.isVisible()) {
          await closeBtn.click()
          await page.waitForTimeout(500)

          const modal = await page.locator('.close-modal, .close-tab-modal').isVisible().catch(() => false)
          console.log(`Close modal opened: ${modal}`)

          await page.screenshot({
            path: `${SCREENSHOT_DIR}/07-close-modal.png`,
            fullPage: true
          })
          console.log('Screenshot: 07-close-modal.png')

          // Cancel the modal
          const cancelBtn = page.locator('.close-modal-cancel, button').filter({ hasText: 'Cancel' })
          if (await cancelBtn.isVisible()) {
            await cancelBtn.click()
            await page.waitForTimeout(300)
          }
        }
      }

      // EC-006: Bottom Status Bar
      console.log('\n=== EC-006: Bottom Status Bar ===')
      const statusBar = await page.locator('.bottom-status-bar').isVisible().catch(() => false)
      console.log(`Bottom status bar visible: ${statusBar}`)

      if (statusBar) {
        const projectName = await page.locator('.bottom-status-project').isVisible().catch(() => false)
        const contextBar = await page.locator('.bottom-status-context').isVisible().catch(() => false)
        const modelButton = await page.locator('.bottom-status-model').isVisible().catch(() => false)
        const costDisplay = await page.locator('.bottom-status-cost').isVisible().catch(() => false)

        console.log(`  Project name: ${projectName}`)
        console.log(`  Context bar: ${contextBar}`)
        console.log(`  Model button: ${modelButton}`)
        console.log(`  Cost display: ${costDisplay}`)

        await page.screenshot({
          path: `${SCREENSHOT_DIR}/08-bottom-status-bar.png`,
          fullPage: true
        })
        console.log('Screenshot: 08-bottom-status-bar.png')

        // EC-006b: Model Selector Modal
        console.log('\n=== EC-006b: Model Selector Modal ===')
        if (modelButton) {
          await page.locator('.bottom-status-model').click()
          await page.waitForTimeout(1000) // Wait for modal and API fetch

          const modelModal = await page.locator('.model-selector-modal').isVisible().catch(() => false)
          console.log(`Model selector modal opened: ${modelModal}`)

          if (modelModal) {
            const searchInput = await page.locator('.model-selector-search-input').isVisible().catch(() => false)
            const providerDropdown = await page.locator('.model-selector-trigger').first().isVisible().catch(() => false)

            console.log(`  Search input: ${searchInput}`)
            console.log(`  Provider dropdown: ${providerDropdown}`)

            await page.screenshot({
              path: `${SCREENSHOT_DIR}/09-model-selector-modal.png`,
              fullPage: true
            })
            console.log('Screenshot: 09-model-selector-modal.png')

            // Test search functionality
            if (searchInput) {
              await page.locator('.model-selector-search-input').fill('claude')
              await page.waitForTimeout(500)

              await page.screenshot({
                path: `${SCREENSHOT_DIR}/10-model-selector-search.png`,
                fullPage: true
              })
              console.log('Screenshot: 10-model-selector-search.png')
            }

            // Close modal
            const cancelBtn = page.locator('.model-selector-button-secondary')
            if (await cancelBtn.isVisible()) {
              await cancelBtn.click()
              await page.waitForTimeout(300)
            }
          }
        }
      }
    }

    // Final full page screenshot
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/11-final-state.png`,
      fullPage: true
    })
    console.log('\nScreenshot: 11-final-state.png')

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

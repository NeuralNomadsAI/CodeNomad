import { chromium } from 'playwright'

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3006'
const SCREENSHOT_DIR = './test-screenshots/phase4'

async function main() {
  console.log('Testing Phase 4 - Detailed Home Screen Review...')

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()

  // Enable console logging
  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log(`Browser error: ${msg.text()}`)
    }
  })

  try {
    console.log('\n=== Loading page ===')
    await page.goto(BASE_URL, { waitUntil: 'networkidle' })
    await page.waitForTimeout(3000)

    // Check what's visible
    const pageContent = await page.content()
    console.log('Page has content:', pageContent.length, 'chars')

    // Look for any visible text or elements
    const visibleText = await page.locator('body').innerText().catch(() => 'none')
    console.log('Visible text (first 200 chars):', visibleText.substring(0, 200))

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/detailed-01-initial.png`,
      fullPage: true
    })

    // Check for project tabs
    const projectTabs = await page.locator('.project-tab').count()
    console.log(`Project tabs count: ${projectTabs}`)

    // Check for loading states
    const loadingSpinner = await page.locator('.spinner').isVisible().catch(() => false)
    console.log(`Loading spinner visible: ${loadingSpinner}`)

    const loadingOverlay = await page.locator('.folder-loading-overlay').isVisible().catch(() => false)
    console.log(`Loading overlay visible: ${loadingOverlay}`)

    // Check for panels
    const panels = await page.locator('.panel').count()
    console.log(`Panel count: ${panels}`)

    // Check for home screen elements
    const homeScreen = await page.locator('.home-screen').isVisible().catch(() => false)
    console.log(`home-screen class visible: ${homeScreen}`)

    // Check for folder selection view elements
    const folderSelectionView = await page.locator('.home-shortcuts-footer').isVisible().catch(() => false)
    console.log(`folder-selection-view footer visible: ${folderSelectionView}`)

    // Check for session tabs
    const sessionTabs = await page.locator('.session-tab').count()
    console.log(`Session tabs count: ${sessionTabs}`)

    // Check for bottom status bar
    const bottomStatusBar = await page.locator('.bottom-status-bar').isVisible().catch(() => false)
    console.log(`Bottom status bar visible: ${bottomStatusBar}`)

    // Check for instance-related elements
    const instanceShell = await page.locator('.message-input-container').isVisible().catch(() => false)
    console.log(`Message input visible: ${instanceShell}`)

    // Wait a bit more and take another screenshot
    await page.waitForTimeout(5000)
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/detailed-02-after-wait.png`,
      fullPage: true
    })

    // Try clicking the + button if visible
    const plusButton = page.locator('.project-tab-new')
    if (await plusButton.isVisible()) {
      console.log('Clicking + button...')
      await plusButton.click()
      await page.waitForTimeout(2000)
      await page.screenshot({
        path: `${SCREENSHOT_DIR}/detailed-03-after-plus.png`,
        fullPage: true
      })
    }

    // Check for FolderSelectionCards elements
    const homeCards = await page.locator('.home-cards').isVisible().catch(() => false)
    console.log(`home-cards visible: ${homeCards}`)

    const homeHero = await page.locator('.home-hero').isVisible().catch(() => false)
    console.log(`home-hero visible: ${homeHero}`)

    // Try to close the existing tab to see initial view
    const closeBtn = page.locator('.project-tab-close').first()
    if (await closeBtn.isVisible()) {
      console.log('Attempting to close tab...')
      await closeBtn.click()
      await page.waitForTimeout(2000)
      await page.screenshot({
        path: `${SCREENSHOT_DIR}/detailed-04-after-close.png`,
        fullPage: true
      })
    }

    // Check for close modal
    const closeModal = await page.locator('.close-modal').isVisible().catch(() => false)
    if (closeModal) {
      console.log('Close modal appeared, clicking confirm...')
      const confirmBtn = page.locator('.close-modal-button-danger')
      if (await confirmBtn.isVisible()) {
        await confirmBtn.click()
        await page.waitForTimeout(2000)
      }
    }

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/detailed-05-final.png`,
      fullPage: true
    })

    console.log('\n=== Detailed Review Complete ===')

  } catch (error) {
    console.error('Error:', error)
    await page.screenshot({ path: `${SCREENSHOT_DIR}/detailed-error.png` })
  } finally {
    await browser.close()
  }
}

main()

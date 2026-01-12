import { chromium } from 'playwright'

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3006'
const SCREENSHOT_DIR = './test-screenshots/phase4'

async function main() {
  console.log('Testing Phase 4 - Home Screen Layouts...')

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()

  try {
    // Test initial home screen (FolderSelectionView)
    console.log('\n=== Testing Initial Home Screen (FolderSelectionView) ===')
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/01-initial-home.png`,
      fullPage: true
    })

    // Check for key elements
    const logoVisible = await page.locator('img[alt*="logo"]').isVisible().catch(() => false)
    console.log(`Logo visible: ${logoVisible}`)

    const recentFoldersPanel = await page.locator('.panel-title:has-text("Recent")').isVisible().catch(() => false)
    console.log(`Recent folders panel visible: ${recentFoldersPanel}`)

    const openFolderPanel = await page.locator('.panel-title:has-text("Open Folder")').isVisible().catch(() => false)
    console.log(`Open Folder panel visible: ${openFolderPanel}`)

    const shortcutsFooter = await page.locator('.home-shortcuts-footer').isVisible().catch(() => false)
    console.log(`Shortcuts footer visible: ${shortcutsFooter}`)

    // Test opening a project to see FolderSelectionCards (New Tab view)
    console.log('\n=== Opening project to test New Tab view ===')

    // Find the path input or use Open by Path
    const pathInput = page.locator('.selector-search-input').first()
    if (await pathInput.isVisible()) {
      await pathInput.fill('/Users/alexanderollman/CodeNomad')
      await page.waitForTimeout(300)

      // Click the Open Folder button
      const openBtn = page.locator('button:has-text("Open Folder")').last()
      if (await openBtn.isVisible() && await openBtn.isEnabled()) {
        await openBtn.click()
        console.log('Clicked Open Folder')
        await page.waitForTimeout(5000)
      }
    }

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/02-project-open.png`,
      fullPage: true
    })

    // Check if project opened
    const projectTab = await page.locator('.project-tab').first().isVisible().catch(() => false)
    console.log(`Project tab visible: ${projectTab}`)

    // Try to open new tab to see FolderSelectionCards
    if (projectTab) {
      const newTabBtn = page.locator('.project-tab-new')
      if (await newTabBtn.isVisible()) {
        await newTabBtn.click()
        console.log('Clicked New Tab button')
        await page.waitForTimeout(1000)
      }
    }

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/03-new-tab-view.png`,
      fullPage: true
    })

    // Check for three-card layout in new tab view
    const homeCards = await page.locator('.home-cards').isVisible().catch(() => false)
    console.log(`Three-card layout visible: ${homeCards}`)

    const recentCard = await page.locator('.home-card-title:has-text("Recent")').isVisible().catch(() => false)
    console.log(`Recent card visible: ${recentCard}`)

    const browseCard = await page.locator('.home-card-title:has-text("Browse")').isVisible().catch(() => false)
    console.log(`Browse card visible: ${browseCard}`)

    const githubCard = await page.locator('.home-card-title:has-text("GitHub")').isVisible().catch(() => false)
    console.log(`GitHub card visible: ${githubCard}`)

    // Final summary
    console.log('\n=== Phase 4 Review Summary ===')
    console.log('- Initial home: FolderSelectionView with 3-column layout')
    console.log('- New tab view: FolderSelectionCards with 3-card layout')
    console.log('Screenshots saved to', SCREENSHOT_DIR)

  } catch (error) {
    console.error('Error:', error)
    await page.screenshot({ path: `${SCREENSHOT_DIR}/error.png` })
  } finally {
    await browser.close()
  }
}

main()

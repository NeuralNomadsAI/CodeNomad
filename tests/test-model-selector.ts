import { chromium } from 'playwright'

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3006'

async function main() {
  console.log('Testing model selector...')

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()

  page.on('console', msg => {
    if (msg.type() === 'error') console.log(`[ERROR]`, msg.text())
  })

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)

    // Open a project first
    const pathInput = page.locator('input')
    await pathInput.fill('/Users/alexanderollman/CodeNomad')
    await page.waitForTimeout(500)

    const openBtn = page.locator('button:has-text("Open Folder"):not([disabled])').last()
    if (await openBtn.isVisible()) {
      await openBtn.click()
      await page.waitForTimeout(3000)
    }

    // Test Cmd+Shift+M to open model selector
    console.log('Testing Cmd+Shift+M shortcut...')
    await page.keyboard.press('Meta+Shift+m')
    await page.waitForTimeout(2000)

    await page.screenshot({
      path: './test-screenshots/ec-review/fix001-model-selector.png',
      fullPage: true
    })

    // Check if models loaded
    const providerDropdown = page.locator('text=Select provider')
    const hasProviders = await providerDropdown.isVisible().catch(() => false)
    console.log(`Provider dropdown visible: ${hasProviders}`)

    // Check for error message
    const errorMsg = page.locator('text=Failed to load models')
    const hasError = await errorMsg.isVisible().catch(() => false)
    console.log(`Error message visible: ${hasError}`)

    // Try clicking provider dropdown
    if (hasProviders) {
      const trigger = page.locator('.model-selector-trigger').first()
      if (await trigger.isVisible()) {
        await trigger.click()
        await page.waitForTimeout(500)

        await page.screenshot({
          path: './test-screenshots/ec-review/fix001-provider-dropdown.png',
          fullPage: true
        })

        // Check if providers are listed
        const providerItems = await page.locator('[role="option"], [data-value]').count()
        console.log(`Provider options found: ${providerItems}`)
      }
    }

    console.log('FIX-001 test complete!')

  } catch (error) {
    console.error('Error:', error)
    await page.screenshot({ path: './test-screenshots/ec-review/fix001-error.png' })
  } finally {
    await browser.close()
  }
}

main()

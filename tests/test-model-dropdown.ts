import { chromium } from 'playwright'

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3006'

async function main() {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)

    // Check if we're on home screen or project view
    const hasInput = await page.locator('input').first().isVisible().catch(() => false)

    if (hasInput) {
      // Open a project
      const pathInput = page.locator('input').first()
      await pathInput.fill('/Users/alexanderollman/CodeNomad')
      await page.waitForTimeout(500)
      const openBtn = page.locator('button:has-text("Open Folder"):not([disabled])').last()
      if (await openBtn.isVisible()) await openBtn.click()
      await page.waitForTimeout(3000)
    }

    // Open model selector
    console.log('Opening model selector with Cmd+Shift+M...')
    await page.keyboard.press('Meta+Shift+m')
    await page.waitForTimeout(1500)

    // Click provider dropdown
    const providerTrigger = page.locator('button:has-text("Select provider")').first()
    console.log(`Provider trigger visible: ${await providerTrigger.isVisible().catch(() => false)}`)

    if (await providerTrigger.isVisible()) {
      await providerTrigger.click()
      await page.waitForTimeout(1000)

      await page.screenshot({
        path: './test-screenshots/ec-review/fix001-providers-list.png',
        fullPage: true
      })

      // Look for provider options
      const anthropicOption = page.locator('text=Anthropic').first()
      const hasAnthropic = await anthropicOption.isVisible().catch(() => false)
      console.log(`Anthropic option visible: ${hasAnthropic}`)

      if (hasAnthropic) {
        await anthropicOption.click()
        await page.waitForTimeout(500)

        await page.screenshot({
          path: './test-screenshots/ec-review/fix001-anthropic-selected.png',
          fullPage: true
        })

        // Click model dropdown
        const modelTrigger = page.locator('button:has-text("Select model")').first()
        if (await modelTrigger.isVisible()) {
          await modelTrigger.click()
          await page.waitForTimeout(1000)

          await page.screenshot({
            path: './test-screenshots/ec-review/fix001-models-list.png',
            fullPage: true
          })
        }
      }
    }

    console.log('Test complete!')
  } catch (error) {
    console.error('Error:', error)
    await page.screenshot({ path: './test-screenshots/ec-review/fix001-error.png' })
  } finally {
    await browser.close()
  }
}

main()

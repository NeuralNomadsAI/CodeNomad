import { chromium } from 'playwright'

async function main() {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const page = await context.newPage()

  // Capture console messages
  page.on('console', msg => {
    const type = msg.type()
    if (type === 'error' || type === 'warning') {
      console.log(`[${type.toUpperCase()}]`, msg.text())
    }
  })

  // Capture page errors
  page.on('pageerror', error => {
    console.log('[PAGE ERROR]', error.message)
  })

  // Capture request failures
  page.on('requestfailed', request => {
    console.log('[REQUEST FAILED]', request.url(), request.failure()?.errorText)
  })

  const baseUrl = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3006'
  console.log(`Navigating to ${baseUrl}...`)
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(3000) // Wait for app to render

  console.log('\nPage title:', await page.title())
  console.log('URL:', page.url())

  // Check what's in the DOM
  const bodyHTML = await page.evaluate(() => document.body.innerHTML.substring(0, 500))
  console.log('\nBody HTML (first 500 chars):\n', bodyHTML)

  // Check for root element
  const rootContent = await page.evaluate(() => {
    const root = document.getElementById('root')
    return root ? root.innerHTML.substring(0, 200) : 'No #root found'
  })
  console.log('\n#root content:\n', rootContent)

  await page.screenshot({ path: './test-screenshots/ec-review/debug-load.png', fullPage: true })
  console.log('\nScreenshot saved to debug-load.png')

  await browser.close()
}

main().catch(console.error)

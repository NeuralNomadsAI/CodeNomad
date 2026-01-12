import { test, expect } from '@playwright/test'

test.describe('EC-007: Message Timeline Scroll Behavior', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    // Wait for the app to load
    await page.waitForSelector('.project-tab-bar', { timeout: 10000 })
  })

  test('should not show double scrollbars when scrolling message area', async ({ page }) => {
    // Check if there's an active session with messages
    const messageStream = page.locator('.message-stream')
    const streamCount = await messageStream.count()

    if (streamCount === 0) {
      // Take screenshot of state without messages
      await page.screenshot({ path: 'test-screenshots/EC-007-no-message-stream.png', fullPage: true })
      return
    }

    // Scroll to top of message stream
    await messageStream.evaluate(el => el.scrollTop = 0)
    await page.waitForTimeout(300)
    await page.screenshot({ path: 'test-screenshots/EC-007-scrolled-to-top.png', fullPage: true })

    // Scroll down slowly to trigger virtualization
    await messageStream.evaluate(el => {
      el.scrollBy({ top: 200, behavior: 'smooth' })
    })
    await page.waitForTimeout(500)
    await page.screenshot({ path: 'test-screenshots/EC-007-after-scroll.png', fullPage: true })

    // Check that there's only one visible scrollbar in the message area
    const scrollbarTrackWidth = await messageStream.evaluate(el => {
      return el.offsetWidth - el.clientWidth
    })

    // Scrollbar should be a reasonable width (not doubled)
    expect(scrollbarTrackWidth).toBeLessThanOrEqual(20)
  })

  test('should not have overlapping timeline segments', async ({ page }) => {
    const timeline = page.locator('.message-timeline')
    const timelineCount = await timeline.count()

    if (timelineCount === 0) {
      await page.screenshot({ path: 'test-screenshots/EC-007-no-timeline.png', fullPage: true })
      return
    }

    // Get all timeline segments
    const segments = page.locator('.message-timeline-segment:not(.message-timeline-segment-hidden)')
    const segmentCount = await segments.count()

    if (segmentCount < 2) {
      await page.screenshot({ path: 'test-screenshots/EC-007-single-segment.png', fullPage: true })
      return
    }

    await page.screenshot({ path: 'test-screenshots/EC-007-timeline-segments.png', fullPage: true })

    // Check that segments don't overlap vertically
    const boundingBoxes = await Promise.all(
      Array.from({ length: segmentCount }, (_, i) =>
        segments.nth(i).boundingBox()
      )
    )

    const validBoxes = boundingBoxes.filter(box => box !== null)

    for (let i = 1; i < validBoxes.length; i++) {
      const prevBox = validBoxes[i - 1]
      const currBox = validBoxes[i]

      if (prevBox && currBox) {
        // Current segment should not overlap with previous
        // Allow 1px tolerance for borders
        const overlap = prevBox.y + prevBox.height > currBox.y + 1
        if (overlap) {
          console.log(`Overlap detected between segments ${i-1} and ${i}:`)
          console.log(`  Previous: y=${prevBox.y}, height=${prevBox.height}, bottom=${prevBox.y + prevBox.height}`)
          console.log(`  Current: y=${currBox.y}`)
        }
        expect(overlap).toBe(false)
      }
    }
  })

  test('should maintain consistent active segment highlighting', async ({ page }) => {
    const activeSegment = page.locator('.message-timeline-segment-active')
    const activeCount = await activeSegment.count()

    if (activeCount === 0) {
      await page.screenshot({ path: 'test-screenshots/EC-007-no-active-segment.png', fullPage: true })
      return
    }

    // Check the active segment's background color - should be the green color #0f5b44
    const activeSegmentEl = activeSegment.first()
    const bgColor = await activeSegmentEl.evaluate(el =>
      window.getComputedStyle(el).backgroundColor
    )

    await page.screenshot({ path: 'test-screenshots/EC-007-active-segment-color.png', fullPage: true })

    // The active background should be the specified green (#0f5b44 = rgb(15, 91, 68))
    // Allow for slight variations but should be green-ish
    expect(bgColor).toMatch(/rgb\(15, 91, 68\)/)
  })

  test('should handle rapid scroll without layout issues', async ({ page }) => {
    const messageStream = page.locator('.message-stream')
    const streamCount = await messageStream.count()

    if (streamCount === 0) {
      await page.screenshot({ path: 'test-screenshots/EC-007-no-stream-rapid.png', fullPage: true })
      return
    }

    // Take before screenshot
    await page.screenshot({ path: 'test-screenshots/EC-007-before-rapid-scroll.png', fullPage: true })

    // Perform rapid scroll up and down
    for (let i = 0; i < 5; i++) {
      await messageStream.evaluate(el => el.scrollTop = 0)
      await page.waitForTimeout(100)
      await messageStream.evaluate(el => el.scrollTop = el.scrollHeight)
      await page.waitForTimeout(100)
    }

    // Wait for layout to stabilize
    await page.waitForTimeout(500)

    // Take after screenshot
    await page.screenshot({ path: 'test-screenshots/EC-007-after-rapid-scroll.png', fullPage: true })

    // Check timeline segments are still properly laid out
    const segments = page.locator('.message-timeline-segment:not(.message-timeline-segment-hidden)')
    const segmentCount = await segments.count()

    if (segmentCount >= 2) {
      const boundingBoxes = await Promise.all(
        Array.from({ length: Math.min(segmentCount, 5) }, (_, i) =>
          segments.nth(i).boundingBox()
        )
      )

      // All visible segments should have positive dimensions
      for (const box of boundingBoxes) {
        if (box) {
          expect(box.width).toBeGreaterThan(0)
          expect(box.height).toBeGreaterThan(0)
        }
      }
    }
  })

  test('should properly update timeline when new message appears', async ({ page }) => {
    const timeline = page.locator('.message-timeline')
    const timelineCount = await timeline.count()

    if (timelineCount === 0) {
      await page.screenshot({ path: 'test-screenshots/EC-007-no-timeline-new-msg.png', fullPage: true })
      return
    }

    // Record initial segment count
    const initialSegments = page.locator('.message-timeline-segment:not(.message-timeline-segment-hidden)')
    const initialCount = await initialSegments.count()

    await page.screenshot({ path: 'test-screenshots/EC-007-initial-timeline.png', fullPage: true })

    // Scroll the message stream up (away from bottom)
    const messageStream = page.locator('.message-stream')
    const streamCount = await messageStream.count()

    if (streamCount > 0) {
      await messageStream.evaluate(el => el.scrollTop = 0)
      await page.waitForTimeout(300)

      await page.screenshot({ path: 'test-screenshots/EC-007-scrolled-up-timeline.png', fullPage: true })

      // Check that timeline segments maintain their layout even when scrolled
      const afterScrollSegments = page.locator('.message-timeline-segment:not(.message-timeline-segment-hidden)')
      const afterScrollCount = await afterScrollSegments.count()

      // Segment count should remain consistent
      expect(afterScrollCount).toBe(initialCount)
    }
  })

  test('should have timeline segments with proper gap spacing', async ({ page }) => {
    const timeline = page.locator('.message-timeline')
    const timelineCount = await timeline.count()

    if (timelineCount === 0) {
      return
    }

    // Get the computed gap from the timeline container
    const gap = await timeline.evaluate(el => {
      const style = window.getComputedStyle(el)
      return style.gap || style.rowGap
    })

    await page.screenshot({ path: 'test-screenshots/EC-007-timeline-gap.png', fullPage: true })

    // Gap should be defined (from CSS: gap: 0.35rem)
    expect(gap).toBeTruthy()

    // Check visible segments have consistent spacing
    const segments = page.locator('.message-timeline-segment:not(.message-timeline-segment-hidden)')
    const segmentCount = await segments.count()

    if (segmentCount >= 2) {
      const boxes = await Promise.all([
        segments.nth(0).boundingBox(),
        segments.nth(1).boundingBox()
      ])

      if (boxes[0] && boxes[1]) {
        const spacing = boxes[1].y - (boxes[0].y + boxes[0].height)
        // Spacing should be positive and consistent with gap value (roughly 0.35rem ≈ 5-6px)
        expect(spacing).toBeGreaterThanOrEqual(0)
        expect(spacing).toBeLessThan(15) // Not too large
      }
    }
  })
})

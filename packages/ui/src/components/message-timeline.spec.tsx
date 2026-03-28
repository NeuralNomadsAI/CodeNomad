import { test, expect } from '@sand4rt/experimental-ct-solid'
import MessageTimeline, { type TimelineSegment } from './message-timeline'
import { ScreenshotWrapper } from './screenshot-wrapper'
import { TestProvider } from '../lib/test-provider'



test('renders message timeline safely with empty segments', async ({ mount }) => {
  const component = await mount(
    <TestProvider>
      <MessageTimeline 
        segments={[]} 
        instanceId="test-instance"
        sessionId="test-session"
      />
    </TestProvider>
  )
  await expect(component).toBeVisible()
})

test('renders a list of diverse timeline segments correctly', async ({ mount }) => {
  const mockSegments: TimelineSegment[] = [
    {
      id: "msg1:0",
      messageId: "msg1",
      type: "user",
      label: "User",
      tooltip: "Hello World",
      totalChars: 11
    },
    {
      id: "msg2:0",
      messageId: "msg2",
      type: "tool",
      label: "calc",
      tooltip: "Tool: calc",
      shortLabel: "C",
      totalChars: 15
    },
    {
      id: "msg2:1",
      messageId: "msg2",
      type: "assistant",
      label: "Assistant",
      tooltip: "Result is 5",
      totalChars: 11
    },
    {
      id: "msg3:0",
      messageId: "msg3",
      type: "compaction",
      label: "Compaction",
      tooltip: "Auto Compaction",
      variant: "auto",
      totalChars: 0
    }
  ]

  const component = await mount(
    <TestProvider>
      <MessageTimeline 
        segments={mockSegments} 
        instanceId="test-instance"
        sessionId="test-session"
      />
    </TestProvider>
  )
  
  await expect(component).toBeVisible()

  const buttons = component.locator('button.message-timeline-segment')
  await expect(buttons).toHaveCount(4)

  // Verify class mappings
  await expect(buttons.nth(0)).toHaveClass(/message-timeline-user/)
  await expect(buttons.nth(1)).toHaveClass(/message-timeline-tool/)
  await expect(buttons.nth(2)).toHaveClass(/message-timeline-assistant/)
  await expect(buttons.nth(3)).toHaveClass(/message-timeline-compaction/)
  await expect(buttons.nth(3)).toHaveClass(/message-timeline-compaction-auto/)

  // Verify label text
  await expect(buttons.nth(0)).toHaveAttribute('aria-label', 'User')
  await expect(buttons.nth(2)).toHaveAttribute('aria-label', 'Assistant')
})

test('dispatches correct click events when a segment is selected', async ({ mount }) => {
  const mockSegments: TimelineSegment[] = [
    {
      id: "msg1:0",
      messageId: "msg1",
      type: "user",
      label: "User",
      tooltip: "Hello World",
      totalChars: 11
    }
  ]

  let clickedId: string | null = null

  const component = await mount(
    <TestProvider>
      <MessageTimeline 
        segments={mockSegments} 
        instanceId="test-instance"
        sessionId="test-session"
        onSegmentClick={(seg) => clickedId = seg.id}
      />
    </TestProvider>
  )

  const button = component.locator('button.message-timeline-segment')
  await button.click()
  expect(clickedId).toBe('msg1:0')
})


test('high-fidelity HD screenshot of timeline with 1000 segments', async ({ mount, page }) => {
  const largeSegments: TimelineSegment[] = Array.from({ length: 1000 }, (_, i) => ({
    id: `msg${i}:0`,
    messageId: `msg${i}`,
    type: i % 4 === 0 ? "user" : i % 4 === 1 ? "assistant" : i % 4 === 2 ? "tool" : "compaction",
    label: i % 4 === 0 ? "User" : i % 4 === 1 ? "Assistant" : i % 4 === 2 ? "Tool" : "Compact",
    tooltip: `Message ${i}`,
    totalChars: 10
  }))

  const component = await mount(
    <ScreenshotWrapper title="Message Timeline - Virtualized History (1000 items)">
      <TestProvider>
        <div style={{ width: '320px', height: '100%', 'border-right': '1px solid rgba(255, 255, 255, 0.05)', display: 'flex', 'flex-direction': 'column' }}>
          <MessageTimeline 
            segments={largeSegments} 
            instanceId="perf-instance"
            sessionId="perf-session"
          />
        </div>
      </TestProvider>
      <div style={{ flex: 1, padding: '60px', display: 'flex', 'flex-direction': 'column', 'justify-content': 'center' }}>
        <h1 style={{ color: '#cdd6f4', 'font-size': '48px', margin: '0 0 16px 0', 'font-family': 'Inter, sans-serif' }}>Navigation & History</h1>
        <p style={{ color: '#a6adc8', 'font-size': '20px', margin: 0, 'line-height': '1.6', 'max-width': '600px' }}>
          Smoothly navigate through thousands of interaction segments with zero lag, thanks to the virtualization engine.
        </p>
      </div>
    </ScreenshotWrapper>
  )

  await expect(component).toBeVisible()
  
  // Wait for rendering to stabilize
  await page.waitForTimeout(1500)
  await page.screenshot({ path: 'message-timeline-hd.png' })
})

test('efficiently renders 1000 timeline segments via virtualization', async ({ mount, page }) => {
  const largeSegments: TimelineSegment[] = Array.from({ length: 1000 }, (_, i) => ({
    id: `msg${i}:0`,
    messageId: `msg${i}`,
    type: i % 3 === 0 ? "user" : i % 3 === 1 ? "assistant" : "tool",
    label: i % 3 === 0 ? "User" : i % 3 === 1 ? "Assistant" : "Tool",
    tooltip: `Message ${i}`,
    totalChars: 10
  }))

  const component = await mount(
    <TestProvider>
      <div style={{ height: '400px', display: 'flex', 'flex-direction': 'column' }}>
        <MessageTimeline 
          segments={largeSegments} 
          instanceId="perf-instance"
          sessionId="perf-session"
        />
      </div>
    </TestProvider>
  )

  await expect(component).toBeVisible()

  // Find the scrollable container. Virtua uses the element with overflow: auto.
  const scrollContainer = component.locator('.message-timeline')
  await expect(scrollContainer).toBeVisible()

  // Initial count check
  const buttons = component.locator('button.message-timeline-segment')
  let count = await buttons.count()
  console.log(`Initially rendered segments: ${count}`)
  expect(count).toBeGreaterThan(10)
  expect(count).toBeLessThan(150) // 400px height / ~20px per item + overscan

  // Scroll to bottom and check again
  await scrollContainer.evaluate((el) => el.scrollTop = el.scrollHeight)
  
  // Wait for virtualizer to react
  await page.waitForTimeout(500)
  
  count = await buttons.count()
  console.log(`Rendered segments after scroll: ${count}`)
  expect(count).toBeGreaterThan(10)
  expect(count).toBeLessThan(150)

  // Verify that the last items are now present
  const lastItem = component.locator('button.message-timeline-segment').last()
  await expect(lastItem).toHaveAttribute('aria-label', /User|Assistant|Tool|Compact/)
  await expect(lastItem).toBeVisible()
})

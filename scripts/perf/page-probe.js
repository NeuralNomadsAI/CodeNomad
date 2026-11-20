// Sample SSE before application handlers, then DOM mutations and the next frame.
(() => {
  const now = () => performance.timeOrigin + performance.now()
  const markers = /MK[A-Z]{2}\d{6}K/g
  let sample
  const afterPaint = callback => requestAnimationFrame(() => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      channel.port2.close()
      callback(now())
    }
    channel.port2.postMessage(0)
  })
  window.EventSource = class extends window.EventSource {
    constructor(url, init) {
      super(url, init)
      this.addEventListener("message", ({ data }) => {
        if (!sample) return
        let payload
        try { payload = JSON.parse(data) } catch { return }
        if (payload?.type === "instance.event" && typeof payload.event?.type === "string"
          && !["server.connected", "server.heartbeat"].includes(payload.event.type)) sample.pageFrames++
      })
    }
  }
  const start = () => {
    new MutationObserver(records => {
      if (!sample) return
      const owner = sample
      const found = new Map()
      function scanText(node) {
        if (!node.data.includes("MK")) return
        const element = node.parentElement
        if (!element?.closest(".message-stream")) return
        for (const match of node.data.matchAll(markers)) {
          if (!(match[0] in owner.shown)) found.set(match[0], { node, index: match.index })
        }
      }
      function scan(node) {
        if (node.nodeType === Node.TEXT_NODE) return scanText(node)
        if (!node.textContent?.includes("MK")) return
        const texts = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
        while (texts.nextNode()) scanText(texts.currentNode)
      }
      owner.mutations += records.length
      for (const record of records) {
        if (record.type === "characterData") scan(record.target)
        else for (const node of record.addedNodes) scan(node)
      }
      if (found.size) afterPaint(at => {
        const range = document.createRange()
        for (const [marker, { node, index }] of found) {
          const element = node.parentElement
          const stream = element?.closest(".message-stream")
          if (!node.isConnected || !stream || node.data.slice(index, index + marker.length) !== marker
            || !element.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue
          if (!owner.visibleOnly) { owner.shown[marker] ??= at; continue }
          range.setStart(node, index)
          range.setEnd(node, index + marker.length)
          const viewport = stream.getBoundingClientRect()
          const rect = range.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0
            && rect.right > Math.max(0, viewport.left) && rect.left < Math.min(innerWidth, viewport.right)
            && rect.bottom > Math.max(0, viewport.top) && rect.top < Math.min(innerHeight, viewport.bottom)) owner.shown[marker] ??= at
        }
      })
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true })
    document.addEventListener("input", event => {
      if (!sample || !event.isTrusted || event.target !== sample.composer) return
      const owner = sample
      afterPaint(at => { owner.keyAt = at })
    }, true)
  }
  if (document.documentElement) start()
  else document.addEventListener("DOMContentLoaded", start, { once: true })
  window.__perf = {
    arm(visibleOnly = true) { sample = { shown: {}, mutations: 0, pageFrames: 0, visibleOnly } },
    disarm() { sample = undefined },
    collect() { return { shown: sample.shown, mutations: sample.mutations, pageFrames: sample.pageFrames } },
    now,
    clearKey(composer) { sample.keyAt = undefined; sample.composer = composer },
    keyAt() { return sample.keyAt },
  }
})()

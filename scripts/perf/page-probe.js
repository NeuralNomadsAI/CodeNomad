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
        if (payload?.type === "instance.event" && typeof payload.event?.id === "string"
          && !["server.connected", "server.heartbeat"].includes(payload.event.type)) sample.pageEvents.add(payload.event.id)
      })
    }
  }
  const start = () => {
    function paintPending(owner) {
      if (owner.scheduled || !owner.pending.size) return
      owner.scheduled = true
      afterPaint(at => {
        owner.scheduled = false
        const range = document.createRange()
        for (const [marker, { node, index }] of owner.pending) {
          const element = node.parentElement
          const stream = element?.closest(".message-stream")
          if (!node.isConnected || !stream || node.data.slice(index, index + marker.length) !== marker) {
            owner.pending.delete(marker)
            continue
          }
          if (!element.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue
          if (owner.visibleOnly) {
            range.setStart(node, index)
            range.setEnd(node, index + marker.length)
            const viewport = stream.getBoundingClientRect()
            const rect = range.getBoundingClientRect()
            const left = Math.max(0, viewport.left, rect.left), right = Math.min(innerWidth, viewport.right, rect.right)
            const top = Math.max(0, viewport.top, rect.top), bottom = Math.min(innerHeight, viewport.bottom, rect.bottom)
            if (!(left < right && top < bottom && element.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2)))) continue
          }
          owner.shown[marker] = at
          owner.pending.delete(marker)
        }
      })
    }
    new MutationObserver(records => {
      if (!sample) return
      const owner = sample
      function scanText(node) {
        if (!node.data.includes("MK")) return
        const element = node.parentElement
        if (!element?.closest(".message-stream")) return
        for (const match of node.data.matchAll(markers)) {
          if (!(match[0] in owner.shown)) owner.pending.set(match[0], { node, index: match.index })
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
        if (record.type === "characterData" || (owner.visibleOnly && record.type === "attributes")) scan(record.target)
        else for (const node of record.addedNodes) scan(node)
      }
      paintPending(owner)
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true })
    document.addEventListener("scroll", () => { if (sample?.visibleOnly) paintPending(sample) }, true)
    document.addEventListener("input", event => {
      if (!sample || !event.isTrusted || event.target !== sample.composer) return
      const owner = sample
      afterPaint(at => { owner.keyAt = at })
    }, true)
  }
  if (document.documentElement) start()
  else document.addEventListener("DOMContentLoaded", start, { once: true })
  window.__perf = {
    arm(visibleOnly = true) { sample = { shown: {}, pending: new Map(), mutations: 0, pageEvents: new Set(), visibleOnly } },
    disarm() { sample = undefined },
    collect(withEvents = false) { return { shown: sample.shown, mutations: sample.mutations, pageEvents: withEvents ? [...sample.pageEvents] : undefined } },
    diagnostic() {
      return [...sample?.pending ?? []].slice(-5).map(([marker, { node, index }]) => {
        const range = document.createRange()
        range.setStart(node, index)
        range.setEnd(node, Math.min(index + marker.length, node.length))
        const { x, y, width, height } = range.getBoundingClientRect()
        return { marker, x, y, width, height, attached: node.isConnected, hit: document.elementFromPoint(x + width / 2, y + height / 2)?.tagName }
      })
    },
    now,
    clearKey(composer) { sample.keyAt = undefined; sample.composer = composer },
    keyAt() { return sample.keyAt },
  }
})()

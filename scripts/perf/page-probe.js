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
      this.addEventListener("message", () => { if (sample) sample.pageFrames++ })
    }
  }
  const start = () => {
    new MutationObserver(records => {
      if (!sample) return
      const owner = sample
      const found = new Set()
      function scan(text) {
        if (text?.includes("MK")) for (const marker of text.match(markers) ?? []) {
          if (!owner.pending.has(marker)) {
            owner.pending.add(marker)
            found.add(marker)
          }
        }
      }
      owner.mutations += records.length
      for (const record of records) {
        if (record.type === "characterData") scan(record.target.data)
        else for (const node of record.addedNodes) scan(node.textContent)
      }
      if (found.size) afterPaint(at => { for (const marker of found) owner.shown[marker] = at })
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true })
    document.addEventListener("input", event => {
      if (!sample || !event.isTrusted) return
      const owner = sample
      afterPaint(at => { owner.keyAt = at })
    }, true)
  }
  if (document.documentElement) start()
  else document.addEventListener("DOMContentLoaded", start, { once: true })
  window.__perf = {
    arm() { sample = { shown: {}, pending: new Set(), mutations: 0, pageFrames: 0 } },
    disarm() { sample = undefined },
    collect() { return { shown: sample.shown, mutations: sample.mutations, pageFrames: sample.pageFrames } },
    now,
    clearKey() { sample.keyAt = undefined },
    keyAt() { return sample.keyAt },
  }
})()

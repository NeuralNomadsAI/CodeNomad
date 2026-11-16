/* CodeNomad push protocol v1. Imported by the generated root-scoped worker. */
(() => {
  self.addEventListener("activate", event => event.waitUntil(caches.delete("asset-cache")))
  const opaque = value => typeof value === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(value)
  const valid = value => value && value.v === 1 && opaque(value.route)
    && typeof value.notificationId === "string" && value.notificationId.length <= 128
    && Number.isFinite(value.expiresAt) && value.expiresAt > Date.now()
    && value.title === "CodeNomad"
    && ["A conversation needs your answer.", "A conversation finished."].includes(value.body)
  function settings(write) {
    return new Promise(resolve => {
      const request = indexedDB.open("codenomad-push-v1", 1)
      request.onupgradeneeded = () => request.result.createObjectStore("settings")
      request.onerror = () => resolve(undefined)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction("settings", write ? "readwrite" : "readonly")
        const store = tx.objectStore("settings")
        const result = write ? store.put(write, "copy") : store.get("copy")
        tx.oncomplete = () => { db.close(); resolve(result.result) }
        tx.onerror = () => { db.close(); resolve(undefined) }
      }
    })
  }
  self.addEventListener("message", event => {
    const data = event.data
    if (event.source && new URL(event.source.url).origin === self.location.origin
      && new URL(event.source.url).pathname === "/"
      && data?.type === "codenomad-push-copy" && data.v === 1
      && [data.needsInput, data.sessionDone].every(text => typeof text === "string" && text.length < 256)) {
      event.waitUntil(settings({ needsInput: data.needsInput, sessionDone: data.sessionDone }))
    }
  })
  self.addEventListener("push", event => {
    let payload
    try { payload = event.data?.json() } catch { return }
    if (!valid(payload)) return
    event.waitUntil((async () => {
      const copy = await settings()
      const category = payload.body === "A conversation needs your answer." ? "needsInput" : "sessionDone"
      await self.registration.showNotification("CodeNomad", {
        body: copy?.[category] ?? payload.body,
        tag: payload.notificationId,
        data: { v: 1, route: payload.route, expiresAt: payload.expiresAt },
      })
    })())
  })
  self.addEventListener("notificationclick", event => {
    event.notification.close()
    const data = event.notification.data
    if (!data || data.v !== 1 || !opaque(data.route) || !Number.isFinite(data.expiresAt) || data.expiresAt <= Date.now()) return
    event.waitUntil((async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
      // Only application documents; login, previews and authenticated media share no navigation authority.
      const client = clients.find(client => {
        const url = new URL(client.url)
        return url.origin === self.location.origin && url.pathname === "/"
      })
      if (client) {
        await client.focus()
        client.postMessage({ v: 1, type: "codenomad-push-route", route: data.route })
      } else {
        await self.clients.openWindow(`/#push=${data.route}`)
      }
    })())
  })
})()

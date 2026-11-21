import assert from "node:assert/strict"
import fs from "node:fs"
import net from "node:net"
import { once } from "node:events"
import type { TestContext } from "node:test"
import type { openSshForward } from "../../codenomad-servers/ssh"

/** Five representations, each raw/URI/form encoded and JSON escaped: 30 scan slots. */
export function sentinelForms(value: string): string[] {
  const base64 = Buffer.from(value).toString("base64")
  const base64url = base64.replaceAll("+", "-").replaceAll("/", "_")
  return [value, base64, base64.replace(/=+$/, ""), base64url, base64url.replace(/=+$/, "")]
    .flatMap(form => [form, encodeURIComponent(form), new URLSearchParams({ value: form }).toString().slice(6)])
    .flatMap(form => [form, JSON.stringify(form).slice(1, -1)])
}

export function assertSentinelsHidden(value: unknown, sentinels: string[], label: string) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  for (const [index, sentinel] of sentinels.entries()) {
    for (const form of sentinelForms(sentinel)) {
      assert.equal(text.includes(form) || text.includes(JSON.stringify(form).slice(1, -1)), false,
        `${label}: exposed sentinel ${index}`)
    }
  }
}

/** Replace only OpenSSH process creation: the relay still owns and dials a real TCP forward. */
export function sentinelForward(t: TestContext, origins: string[], keyPath: string, key: string) {
  const opened: string[] = []
  const open: typeof openSshForward = (host, target, options) => {
    const index = ["fixture-A", "fixture-B"].indexOf(host)
    assert.ok(index >= 0)
    const destination = new URL(origins[index]!)
    assert.equal(target, destination.host)
    assert.equal(fs.readFileSync(keyPath, "utf8"), key)
    opened.push(host)
    const sockets = new Set<net.Socket>()
    const server = net.createServer(socket => {
      const remote = net.connect(Number(destination.port), destination.hostname)
      for (const stream of [socket, remote]) {
        sockets.add(stream)
        stream.once("close", () => sockets.delete(stream))
        stream.once("error", () => { socket.destroy(); remote.destroy() })
      }
      socket.pipe(remote).pipe(socket)
    })
    server.listen(0, "127.0.0.1")
    const ready = once(server, "listening").then(() => (server.address() as net.AddressInfo).port)
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      for (const socket of sockets) socket.destroy()
      server.close()
      options?.onExit?.()
    }
    t.after(close)
    return { ready, close }
  }
  return { open, opened }
}

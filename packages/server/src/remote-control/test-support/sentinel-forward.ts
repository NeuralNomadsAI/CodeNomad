import assert from "node:assert/strict"
import fs from "node:fs"
import net from "node:net"
import { once } from "node:events"
import type { TestContext } from "node:test"
import type { openSshForward } from "../../codenomad-servers/ssh"

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

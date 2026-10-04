// Actual native starter pipes/close, intentionally NOT a ChildProcess imitation.
import { EventEmitter } from "node:events"
import { Readable } from "node:stream"
/**
 * @typedef {{
 * prepareServiceStarter(session: object, grant: Buffer, bytes: Buffer): Promise<object>,
 * readServiceStarter(starter: object, stream: "stdout" | "stderr"): Promise<{eof: true} | {bytes: string, eof?: false}>,
 * waitServiceStarter(starter: object): Promise<{exitCode: number, drained: boolean} | null>,
 * killServiceStarter(starter: object): Promise<void>,
 * finishServiceStarter(starter: object): Promise<Buffer>,
 * closeServiceStarter(starter: object): void
 * }} NativeServicePeerSdk
 */
/**
 * Return the real native starter plus a shared, synchronously prepared handoff.
 * The producer retains ownership until it returns the token to the launcher.
 * @param {NativeServicePeerSdk} sdk
 * @param {object} session
 * @param {Buffer} grant
 * @param {Buffer} bytes
 * @param {typeof import("../../server/src/workspaces/native-service-launcher.js").prepareServiceStarter} prepareServiceStarter
 */
export async function prepareOwnedStarter(sdk, session, grant, bytes, prepareServiceStarter) {
  const native = await sdk.prepareServiceStarter(session, grant, bytes)
  const events = new EventEmitter()
  let closed = false, killing = false
  /** @param {"stdout" | "stderr"} name */
  const stream = name => {
    let busy = false
    return new Readable({ read() {
      if (busy || this.destroyed) return; busy = true
      /** @returns {void} */
      const pull = () => { void sdk.readServiceStarter(native, name).then(value => {
        if (this.destroyed) { busy = false; return }
        if (value.eof) { busy = false; this.push(null); return }
        const bytes = Buffer.from(value.bytes, "hex")
        if (!bytes.length) { pull(); return }
        busy = false; this.push(bytes)
      }, () => { busy = false; this.destroy(new Error("native-service-stream-failed")); }) }
      pull()
    } })
  }
  const stdout = stream("stdout"), stderr = stream("stderr")
  const starter = {
    stdout, stderr, exitCode: /** @type {number | null} */ (null), signalCode: /** @type {string | null} */ (null),
    /** @param {"error"} event @param {(error: Error) => void} callback */
    on(event, callback) { events.on(event, callback); return starter },
    /** @param {"error" | "close"} event @param {(...args: any[]) => void} callback */
    once(event, callback) { events.once(event, callback); return starter },
    kill() {
      if (!killing && !closed) { killing = true; void sdk.killServiceStarter(native).catch(() => {}) }
      return true
    },
    async receipt() { return sdk.finishServiceStarter(native) },
    release() { if (!closed) starter.kill(); sdk.closeServiceStarter(native) },
  }
  /** @returns {Promise<void>} */
  const poll = async () => {
    try {
      const status = await sdk.waitServiceStarter(native)
      if (status) starter.exitCode = status.exitCode
      if (status?.drained) { closed = true; events.emit("close", status.exitCode); return }
      if (!killing) setTimeout(poll, 5)
    } catch { starter.kill(); events.emit("error", new Error("native-service-close-failed")) }
  }
  // Capture actual failures/close before yielding this starter through any
  // Promise. The shared handoff retains them, rather than merely swallowing them.
  const handoff = prepareServiceStarter(starter)
  setTimeout(poll, 0)
  return { starter, handoff }
}

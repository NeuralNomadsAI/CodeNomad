import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import { createServer } from "node:net"
import os from "node:os"
import path from "node:path"
import { ExplicitEndpointError } from "../opencode/servers/endpoint"

/** An OpenSSH destination: a config alias, `user@host` or `ssh://user@host:port`. Never an option. */
export const SSH_HOST = /^[A-Za-z0-9_.@:/[\]%+][A-Za-z0-9_.@:/[\]%+-]{0,254}$/

const READY = "Entering interactive session"
const CONNECT_TIMEOUT_MS = 30_000
const CONFIG_LIMIT_BYTES = 256 * 1024
const CONFIG_FILES = 64
const HOSTS = 500

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error()))
    })
  })
}

function failure(log: string): ExplicitEndpointError {
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No .* host key is known/i.test(log)) return new ExplicitEndpointError("ssh_host_key")
  if (/Permission denied|Too many authentication failures/i.test(log)) return new ExplicitEndpointError("ssh_auth")
  return new ExplicitEndpointError("network")
}

export type SshForward = { /** The owned local port, once this client has bound it and authenticated. */ ready: Promise<number>; close(): void }

/**
 * One owned `ssh -N -L` client to `target` (`host:port` as seen from the SSH host). It uses the
 * user's OpenSSH configuration, keys and agent, never prompts, never trusts an unknown host key
 * and shares no multiplexing master. `onExit` fires once when the forward can no longer be used.
 */
export function openSshForward(host: string, target: string, options: {
  onExit?: () => void
  spawn?: (args: string[]) => ChildProcess
} = {}): SshForward {
  let child: ChildProcess | undefined
  let closed = false
  let exited = false
  const exit = () => { if (!exited) { exited = true; options.onExit?.() } }
  const ready = (async () => {
    if (!SSH_HOST.test(host)) throw new ExplicitEndpointError("invalid_origin")
    const port = await freePort()
    if (closed) throw new ExplicitEndpointError("network")
    const args = ["-v", "-N", "-T",
      "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ExitOnForwardFailure=yes",
      "-o", "ControlMaster=no", "-o", "ControlPath=none",
      "-o", "ForkAfterAuthentication=no", "-o", "ClearAllForwardings=no",
      "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
      "-L", `127.0.0.1:${port}:${target}`, "--", host]
    const running = child = (options.spawn ?? (argv => spawn("ssh", argv, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] })))(args)
    return await new Promise<number>((resolve, reject) => {
      let log = ""
      let settled = false
      const timer = setTimeout(() => running.kill(), CONNECT_TIMEOUT_MS)
      // The client logs this only after authentication and after binding every requested forward,
      // which ExitOnForwardFailure makes fatal: a listener on the port before it belongs to someone else.
      running.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
        if (settled) return
        log = (log + chunk).slice(-16_384)
        if (log.includes(READY)) { settled = true; clearTimeout(timer); resolve(port) }
      })
      running.once("error", () => { clearTimeout(timer); settled = true; reject(new ExplicitEndpointError("ssh_unavailable")); exit() })
      running.once("exit", () => { clearTimeout(timer); if (!settled) { settled = true; reject(failure(log)) } exit() })
    })
  })()
  ready.catch(exit)
  return { ready, close() { closed = true; child?.kill() } }
}

/** Concrete `Host` aliases of the user's OpenSSH configuration, following `Include`. OpenSSH alone interprets them. */
export function listSshHosts(home = os.homedir()): string[] {
  const directory = path.join(home, ".ssh")
  const hosts = new Set<string>()
  const seen = new Set<string>()
  const read = (file: string) => {
    if (seen.has(file) || seen.size >= CONFIG_FILES) return
    seen.add(file)
    let text: string
    try {
      if (fs.statSync(file).size > CONFIG_LIMIT_BYTES) return
      text = fs.readFileSync(file, "utf8")
    } catch { return }
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(host|include)(?:\s*=\s*|\s+)(.+?)\s*$/i.exec(line)
      if (!match) continue
      const values = [...match[2]!.matchAll(/"([^"]*)"|(\S+)/g)].map(value => value[1] ?? value[2]!)
      const comment = values.findIndex(value => value.startsWith("#"))
      if (comment !== -1) values.splice(comment)
      if (match[1]!.toLowerCase() === "host") {
        for (const value of values) if (hosts.size < HOSTS && SSH_HOST.test(value) && !/[*?!]/.test(value)) hosts.add(value)
        continue
      }
      for (const value of values) {
        const pattern = value.startsWith("~/") ? path.join(home, value.slice(2)) : path.isAbsolute(value) ? value : path.join(directory, value)
        let files: string[]
        try { files = /[*?[]/.test(pattern) ? fs.globSync(pattern.replaceAll("\\", "/")).sort() : [pattern] } catch { files = [] }
        for (const included of files) read(path.resolve(included))
      }
    }
  }
  read(path.join(directory, "config"))
  return [...hosts]
}

import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"
import { PassThrough } from "node:stream"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { listSshHosts, openSshForward, SSH_HOST } from "./ssh"

test("SSH destinations cannot inject options or shell syntax", () => {
  for (const host of ["lab", "user@lab", "ssh://user@lab:2222", "[::1]"]) assert.ok(SSH_HOST.test(host))
  for (const host of ["-oProxyCommand=x", "lab;command", "lab\nother", "lab other", ""]) assert.equal(SSH_HOST.test(host), false)
})

test("host import follows Includes and ignores comments and wildcard patterns", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-hosts-"))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  fs.mkdirSync(path.join(home, ".ssh"))
  fs.writeFileSync(path.join(home, ".ssh/config"), 'Host first second # comment\nHost * !excluded test?\nInclude "extra"\n')
  fs.writeFileSync(path.join(home, ".ssh/extra"), "Host third\nInclude config\n")
  assert.deepEqual(listSshHosts(home), ["first", "second", "third"])
})

test("forward waits for authenticated readiness and reports its owned child's exit", async () => {
  let exits = 0
  let args: string[] = []
  const child = Object.assign(new EventEmitter(), {
    stderr: new PassThrough(),
    kill() { child.emit("exit", 0); return true },
  })
  const forward = openSshForward("lab", "127.0.0.1:9898", {
    onExit: () => exits++,
    spawn(argv) {
      args = argv
      queueMicrotask(() => child.stderr.write("debug1: Entering interactive session.\n"))
      return child as unknown as ChildProcess
    },
  })
  const port = await forward.ready
  assert.ok(port > 0)
  assert.ok(args.includes(`127.0.0.1:${port}:127.0.0.1:9898`))
  assert.ok(args.includes("StrictHostKeyChecking=yes"))
  assert.ok(args.includes("ForkAfterAuthentication=no"))
  assert.ok(args.includes("ClearAllForwardings=no"))
  assert.deepEqual(args.slice(-2), ["--", "lab"])
  assert.equal(exits, 0)
  forward.close()
  assert.equal(exits, 1)
})

test("authentication failure never supplies a dial port", async () => {
  const child = Object.assign(new EventEmitter(), { stderr: new PassThrough(), kill() { return true } })
  const forward = openSshForward("lab", "127.0.0.1:9898", {
    spawn() {
      queueMicrotask(() => {
        child.stderr.write("Permission denied (publickey).\n")
        child.emit("exit", 255)
      })
      return child as unknown as ChildProcess
    },
  })
  await assert.rejects(forward.ready, { code: "ssh_auth" })
})
